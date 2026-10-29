import { createHash, randomBytes } from "node:crypto";
import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDatabaseUrl } from "../../src/store/database-url.ts";
import { migrate, migrationsDirectory } from "../../src/store/migrate.ts";

const BASE = resolveDatabaseUrl();

function urlFor(database: string): string {
  const url = new URL(BASE);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Unique per process, so two concurrent runs never create and drop one another's scratch databases mid-suite. It is
 * not derived from `DATABASE_URL`, because the two ways this suite is normally run both leave that at a fixed name —
 * `vitest.integration.config.mts` falls back to `agent_hub_test`, and `Jenkinsfile_CNP` sets `agent_hub` — so a name
 * derived from it would collide for exactly the people who have not overridden it.
 */
const RUN = `${process.pid.toString(36)}_${randomBytes(4).toString("hex")}`;

/** The namespace every scratch database this file creates sits in, shared with `SCRATCH_PATTERN` so the two cannot drift. */
const SCRATCH_PREFIX = "agent_hub_scratch";

/**
 * Every database this file creates is named through here. A fixed name looks harmless because the suite drops it
 * first, but a sibling run drops and recreates the same one mid-test: the symptoms are a `CREATE DATABASE` that
 * collides on `pg_database_datname_index`, or a query that fails because the other run's `afterAll` has just dropped
 * the database out from under it.
 */
function scratchDatabase(suffix: string): string {
  return `${SCRATCH_PREFIX}_${suffix}_${RUN}`;
}

const SCRATCH = scratchDatabase("migrate");

/** How long ago a scratch database must have been created before a later run treats it as abandoned and reclaims it. */
const ORPHAN_HOURS = 2;

/**
 * Every name `scratchDatabase` can produce: the namespace, any suffix at all, and a `RUN`. The suffix is deliberately
 * unconstrained, because a pattern that spelled out the suffixes this file happens to use today would silently stop
 * matching the day someone added another one — and a sweep that matches nothing looks exactly like a sweep with
 * nothing to do. The trailing `RUN` is what keeps a hand-made database out of it.
 */
const SCRATCH_PATTERN = `^${SCRATCH_PREFIX}_.+_[0-9a-z]+_[0-9a-f]{8}$`;

async function query<T extends pg.QueryResultRow>(database: string, statement: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: urlFor(database) });
  await client.connect();
  try {
    return (await client.query<T>(statement)).rows;
  } finally {
    await client.end();
  }
}

/**
 * Drops the scratch databases earlier runs abandoned. A per-run name is never reused, so a run killed between
 * `beforeAll` and `afterAll` would otherwise leave its databases on the server for good — the fixed names this file
 * used to use at least got reclaimed by the next run.
 *
 * Age — the mtime of `PG_VERSION`, which is written when the database is created — is the only safe evidence that a
 * database is finished with. Having no connection is not: `query` opens one per statement and closes it, so a
 * concurrent run's scratch database is idle most of the time, and dropping an idle one would recreate the cross-run
 * interference the per-run names exist to prevent. This runs before the file creates any of its own, so the window
 * only has to outlast a run of this file.
 *
 * Best-effort, because reading a database's age needs privileges the pipeline's user may not have, and leftover
 * clutter is not worth failing the suite over.
 */
async function dropAbandonedScratchDatabases(): Promise<void> {
  try {
    const abandoned = await query<{ datname: string }>(
      "postgres",
      `SELECT datname FROM pg_database
        WHERE datname ~ '${SCRATCH_PATTERN}'
          AND (pg_stat_file('base/' || oid || '/PG_VERSION')).modification < now() - make_interval(hours => ${ORPHAN_HOURS})`
    );
    for (const { datname } of abandoned) {
      await query("postgres", `DROP DATABASE IF EXISTS "${datname}"`);
    }
  } catch {
    // Nothing here is worth a failure: the suite's own databases do not depend on the sweep having run.
  }
}

beforeAll(async () => {
  await dropAbandonedScratchDatabases();
});

describe("migrate", () => {
  const original = process.env.DATABASE_URL;

  beforeAll(async () => {
    await query("postgres", `DROP DATABASE IF EXISTS "${SCRATCH}"`);
    await query("postgres", `CREATE DATABASE "${SCRATCH}"`);
    process.env.DATABASE_URL = urlFor(SCRATCH);
  });

  afterAll(async () => {
    if (original === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = original;
    }
    await query("postgres", `DROP DATABASE IF EXISTS "${SCRATCH}"`);
  });

  it("should create every table, with singular names, when the database is empty", async () => {
    expect((await migrate()).length).toBeGreaterThan(0);

    const tables = await query<{ table_name: string }>(
      SCRATCH,
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
    );
    expect(tables.map((row) => row.table_name)).toEqual([
      "_prisma_migrations",
      "agent",
      "agent_grant",
      "agent_question",
      "assistant_conversation",
      "assistant_conversation_fork",
      "assistant_conversation_share",
      "assistant_export_default",
      "assistant_lookup",
      "assistant_model_choice",
      "assistant_template",
      "assistant_upload",
      "assistant_upload_part",
      "channel",
      "credential",
      "delivery",
      "dev_credential_value",
      "message",
      "message_topic",
      "orchestrator_lease",
      "subscription",
      "topic",
      "transcript_entry",
      "user",
      "virtual_agent",
      "virtual_agent_login"
    ]);
  });

  it("should create the indexes the feed, the delivery replay and the owner lookups read", async () => {
    const indexes = await query<{ indexdef: string }>(SCRATCH, "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'");
    const definitions = indexes.map((row) => row.indexdef);

    expect(definitions).toContainEqual(expect.stringContaining("ON public.message_topic USING btree (topic_id, message_id)"));
    expect(definitions).toContainEqual(expect.stringContaining("ON public.delivery USING btree (agent_id, state)"));
    expect(definitions).toContainEqual(expect.stringContaining("ON public.agent USING btree (owner_oid)"));
  });

  it("should create the topic-count trigger as a deferred constraint trigger on both tables", async () => {
    const triggers = await query<{ table: string; deferrable: boolean; deferred: boolean }>(
      SCRATCH,
      `SELECT tgrelid::regclass::text AS table, tgdeferrable AS deferrable, tginitdeferred AS deferred
         FROM pg_trigger WHERE tgname = 'message_topic_count' ORDER BY 1`
    );

    expect(triggers).toEqual([
      { table: "message", deferrable: true, deferred: true },
      { table: "message_topic", deferrable: true, deferred: true }
    ]);
  });

  it("should apply nothing on a second run", async () => {
    expect(await migrate()).toEqual([]);
  });

  it("should record each migration in the ledger Prisma reads", async () => {
    const rows = await query<{ checksum: string; finished: boolean }>(
      SCRATCH,
      `SELECT checksum, finished_at IS NOT NULL AS finished FROM "_prisma_migrations"`
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.finished).toBe(true);
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("should apply each migration once when several pods boot together", async () => {
    await query("postgres", `DROP DATABASE IF EXISTS "${SCRATCH}"`);
    await query("postgres", `CREATE DATABASE "${SCRATCH}"`);

    const runs = await Promise.all([migrate(), migrate(), migrate()]);

    expect(runs.flat().length).toBe((await query(SCRATCH, `SELECT 1 FROM "_prisma_migrations"`)).length);
  });

  it("should record the sha256 of each migration file as its checksum", async () => {
    const rows = await query<{ migration_name: string; checksum: string }>(SCRATCH, `SELECT migration_name, checksum FROM "_prisma_migrations"`);

    for (const row of rows) {
      const sql = await readFile(path.join(migrationsDirectory(), row.migration_name, "migration.sql"));
      expect(row.checksum).toBe(createHash("sha256").update(sql).digest("hex"));
    }
  });

  describe("when an applied migration's file has changed", () => {
    let directory: string;

    beforeEach(async () => {
      directory = await mkdtemp(path.join(tmpdir(), "agent-hub-migrations-"));
      await cp(migrationsDirectory(), directory, { recursive: true });
    });

    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it("should fail naming the migration when its file no longer matches the ledger", async () => {
      const [first] = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      await appendFile(path.join(directory, first!, "migration.sql"), "\n-- edited after it was applied\n");

      await expect(migrate(directory)).rejects.toThrow(`migration ${first} has changed since it was applied`);
    });

    it("should apply no pending migration when an earlier one has changed", async () => {
      const [first] = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      await appendFile(path.join(directory, first!, "migration.sql"), "\n-- edited after it was applied\n");
      await mkdir(path.join(directory, "99991231000000_pending"));
      await writeFile(path.join(directory, "99991231000000_pending", "migration.sql"), "CREATE TABLE never_created (id INTEGER);\n");

      await expect(migrate(directory)).rejects.toThrow(/has changed since it was applied/);

      expect(await query(SCRATCH, "SELECT 1 FROM information_schema.tables WHERE table_name = 'never_created'")).toEqual([]);
    });
  });
});

describe("migrate waiting for the database", () => {
  const original = process.env.DATABASE_URL;

  afterAll(() => {
    if (original === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = original;
    }
  });

  it("should retry a refused connection while the database is still starting", async () => {
    process.env.DATABASE_URL = "postgresql://hmcts:hmcts@127.0.0.1:1/never_listening";
    let waits = 0;

    await expect(
      migrate(migrationsDirectory(), async () => {
        waits += 1;
        if (waits > 2) {
          throw new Error("stop waiting");
        }
      })
    ).rejects.toThrow();

    expect(waits).toBeGreaterThan(1);
  });

  it("should fail immediately when the database answers with a refusal of its own", async () => {
    process.env.DATABASE_URL = urlFor("no_such_database_here");
    const pause = vi.fn<(ms: number) => Promise<void>>();

    await expect(migrate(migrationsDirectory(), pause)).rejects.toThrow();

    expect(pause).not.toHaveBeenCalled();
  });
});

/**
 * An empty scratch database pointed at by `DATABASE_URL`, and a copy of `prisma/migrations/` with `migration` and
 * everything after it removed, so a test can migrate to the state just before it, seed rows, and then apply it.
 *
 * Registers its own `beforeAll`/`afterAll` against the calling `describe`, which is what lets one migration's test
 * read as the assertion it is. `earlier()` is a function because the directory does not exist until `beforeAll` runs.
 */
function migrationFixture(suffix: string, migration: string): { database: string; earlier: () => string } {
  const database = scratchDatabase(suffix);
  const original = process.env.DATABASE_URL;
  let earlier: string | undefined;

  beforeAll(async () => {
    await query("postgres", `DROP DATABASE IF EXISTS "${database}"`);
    await query("postgres", `CREATE DATABASE "${database}"`);
    process.env.DATABASE_URL = urlFor(database);
    earlier = await mkdtemp(path.join(tmpdir(), "agent-hub-migrations-"));
    await cp(migrationsDirectory(), earlier, { recursive: true });
    for (const name of await readdir(earlier)) {
      if (/^\d/.test(name) && name >= migration) {
        await rm(path.join(earlier, name), { recursive: true });
      }
    }
  });

  afterAll(async () => {
    if (original === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = original;
    }
    // Guarded because `beforeAll` may have thrown before assigning it: an `rm(undefined)` here would replace that
    // failure with a confusing `TypeError` and, worse, skip the `DROP DATABASE` below, leaking the scratch database
    // until the sweep's `ORPHAN_HOURS` are up.
    if (earlier !== undefined) {
      await rm(earlier, { recursive: true, force: true });
    }
    await query("postgres", `DROP DATABASE IF EXISTS "${database}"`);
  });

  return {
    database,
    earlier: () => earlier as string
  };
}

describe("the bedrock migration", () => {
  const MIGRATION = "20261009090000_bedrock";
  const { database: RENAME, earlier } = migrationFixture("migrate_bedrock", MIGRATION);

  it("should move existing gateway virtual agents to bedrock, and leave them back on gateway at head, when it is applied", async () => {
    await migrate(earlier());
    await query(RENAME, `INSERT INTO "user" (oid, tid, name) VALUES ('dev-alice', 'dev', 'Alice')`);
    await query(
      RENAME,
      `INSERT INTO "virtual_agent" (owner_oid, name, model_route) VALUES ('dev-alice', 'on-gateway', 'gateway'), ('dev-alice', 'own', 'own_licence')`
    );

    expect((await migrate())[0]).toBe(MIGRATION);

    // `migrate()` applies every migration from this one on, so what is asserted is the state at head rather than the
    // one this migration left: `20261107090000_bedrock_gone` moves the renamed row back to `gateway` and takes the
    // value out of both enums again.
    const agents = await query<{ name: string; model_route: string }>(RENAME, `SELECT name, model_route::text FROM "virtual_agent" ORDER BY name`);
    expect(agents).toEqual([
      { name: "on-gateway", model_route: "gateway" },
      { name: "own", model_route: "own_licence" }
    ]);
    const labels = await query<{ type: string; label: string }>(
      RENAME,
      `SELECT t.typname AS type, e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname IN ('credential_kind', 'model_route') ORDER BY t.typname, e.enumsortorder`
    );
    // `bedrock` is still a label on both types at head: `20261107090000_bedrock_gone` moves every row off it and
    // deletes the credentials, and leaves the labels for a release so the build it replaces can keep reading the
    // columns. `model_route` carries it first because the rename this migration makes keeps the value's sort order
    // and `20261106090000_model_route_gateway` added `gateway` after it.
    expect(labels).toEqual([
      { type: "credential_kind", label: "github" },
      { type: "credential_kind", label: "azure" },
      { type: "credential_kind", label: "claude" },
      { type: "credential_kind", label: "bedrock" },
      { type: "credential_kind", label: "jenkins" },
      { type: "credential_kind", label: "claude_md" },
      { type: "credential_kind", label: "git_identity" },
      { type: "credential_kind", label: "atlassian" },
      { type: "model_route", label: "bedrock" },
      { type: "model_route", label: "gateway" },
      { type: "model_route", label: "own_licence" }
    ]);
  });
});

describe("the bedrock-gone migration", () => {
  const MIGRATION = "20261107090000_bedrock_gone";
  const { database: GONE, earlier } = migrationFixture("migrate_bedrock_gone", MIGRATION);

  it("should move a bedrock agent to the gateway, bump its generations and delete the stored keys when it is applied", async () => {
    await migrate(earlier());
    await query(GONE, `INSERT INTO "user" (oid, tid, name) VALUES ('dev-alice', 'dev', 'Alice')`);
    await query(
      GONE,
      `INSERT INTO "virtual_agent" (owner_oid, name, model_route) VALUES ('dev-alice', 'assistant', 'bedrock'), ('dev-alice', 'own', 'own_licence')`
    );
    await query(
      GONE,
      `INSERT INTO "credential" (owner_oid, kind, secret_name, updated_via)
        VALUES ('dev-alice', 'bedrock', 'u-dev-alice-bedrock', 'web'), ('dev-alice', 'github', 'u-dev-alice-github', 'web')`
    );
    // A key was pasted rather than signed in for, so this row should never exist; seeded because one that did would
    // otherwise be left behind pointing at a kind the application no longer has.
    await query(
      GONE,
      `INSERT INTO "virtual_agent_login" (virtual_agent_id, kind, prompt, verification_uri, expires_at)
        SELECT id, 'bedrock', 'paste_code', 'https://example.invalid', now() + interval '1 hour'
          FROM "virtual_agent" WHERE name = 'assistant'`
    );

    expect((await migrate())[0]).toBe(MIGRATION);

    const agents = await query<{ name: string; model_route: string }>(GONE, `SELECT name, model_route::text FROM "virtual_agent" ORDER BY name`);
    expect(agents).toEqual([
      { name: "assistant", model_route: "gateway" },
      { name: "own", model_route: "own_licence" }
    ]);
    const credentials = await query<{ kind: string }>(GONE, `SELECT kind::text FROM "credential" ORDER BY kind::text`);
    expect(credentials).toEqual([{ kind: "github" }]);
    expect(await query(GONE, `SELECT 1 FROM "virtual_agent_login"`)).toEqual([]);
    // The orchestrator claims a row only when its generation is ahead of the one it last observed, so a pod already
    // running on the old route is re-applied onto the gateway rather than keeping the route in its environment.
    const moved = await query<{ generation: number; pod_generation: number }>(
      GONE,
      `SELECT generation, pod_generation FROM "virtual_agent" WHERE name = 'assistant'`
    );
    const untouched = await query<{ generation: number; pod_generation: number }>(
      GONE,
      `SELECT generation, pod_generation FROM "virtual_agent" WHERE name = 'own'`
    );
    expect(Number(moved[0]?.generation)).toBeGreaterThan(Number(untouched[0]?.generation));
    expect(Number(moved[0]?.pod_generation)).toBeGreaterThan(Number(untouched[0]?.pod_generation));
    // Both labels stay on their types for one release. The previous build is still serving while this commits, and
    // rebuilding either type would change the column's result-type OID under its cached statements.
    const labels = await query<{ type: string; label: string }>(
      GONE,
      `SELECT t.typname AS type, e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname IN ('credential_kind', 'model_route') AND e.enumlabel = 'bedrock' ORDER BY t.typname`
    );
    expect(labels).toEqual([
      { type: "credential_kind", label: "bedrock" },
      { type: "model_route", label: "bedrock" }
    ]);
  });
});

describe("the assistant product list migration", () => {
  const MIGRATION = "20261025120000_assistant_product_list";
  const { database: REMAP, earlier } = migrationFixture("migrate_product", MIGRATION);

  it("should move conversations off the retired product and default new ones to general when it is applied", async () => {
    await migrate(earlier());
    await query(REMAP, `INSERT INTO "user" (oid, tid, name) VALUES ('dev-alice', 'dev', 'Alice')`);
    await query(REMAP, `INSERT INTO "virtual_agent" (owner_oid, name, model_route) VALUES ('dev-alice', 'assistant', 'own_licence')`);
    await query(
      REMAP,
      `INSERT INTO "assistant_conversation" (owner_oid, virtual_agent_id, title, product, product_history)
        SELECT 'dev-alice', id, t.title, t.product, t.history::jsonb FROM "virtual_agent",
          (VALUES ('left on other', 'other', '[{"product": "other", "at": "2026-10-21T09:00:00.000Z"}]'), ('on a product', 'ccd', '[]'))
            AS t (title, product, history)`
    );

    expect((await migrate())[0]).toBe(MIGRATION);

    await query(REMAP, `INSERT INTO "assistant_conversation" (owner_oid, virtual_agent_id, title) SELECT 'dev-alice', id, 'new' FROM "virtual_agent"`);
    const conversations = await query<{ title: string; product: string; product_history: unknown }>(
      REMAP,
      `SELECT title, product, product_history FROM "assistant_conversation" ORDER BY title`
    );
    expect(conversations).toEqual([
      // The history is an audit trail of what was picked, so the retired slug stays in it.
      { title: "left on other", product: "general", product_history: [{ product: "other", at: "2026-10-21T09:00:00.000Z" }] },
      { title: "new", product: "general", product_history: [] },
      { title: "on a product", product: "ccd", product_history: [] }
    ]);
  });
});

/**
 * The sweep's pattern and the name generator have to agree, and nothing else in the suite would notice if they
 * stopped: an unswept name leaks silently, and `dropAbandonedScratchDatabases` swallows its own errors by design.
 */
describe("the scratch database sweep's pattern", () => {
  const pattern = new RegExp(SCRATCH_PATTERN);

  it.each(["migrate", "migrate_bedrock", "migrate_bedrock_gone", "migrate_product", "assistant2", "x", "a_much_longer_suffix_9"])(
    "should match the name the generator produces for the %s suffix",
    (suffix) => {
      expect(scratchDatabase(suffix)).toMatch(pattern);
    }
  );

  it.each(["agent_hub", "agent_hub_test", "agent_hub_migrate_probe", "agent_hub_scratch_probe", `${SCRATCH_PREFIX}_migrate`])(
    "should leave %s alone, because nothing generated it",
    (name) => {
      expect(name).not.toMatch(pattern);
    }
  );
});
