import { createHash } from "node:crypto";
import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_DATABASE_URL } from "../../src/store/database-url.ts";
import { migrate, migrationsDirectory } from "../../src/store/migrate.ts";

const SCRATCH = "agent_hub_migrate_test";
const BASE = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;

function urlFor(database: string): string {
  const url = new URL(BASE);
  url.pathname = `/${database}`;
  return url.toString();
}

async function query<T extends pg.QueryResultRow>(database: string, statement: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: urlFor(database) });
  await client.connect();
  try {
    return (await client.query<T>(statement)).rows;
  } finally {
    await client.end();
  }
}

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
      "channel",
      "delivery",
      "message",
      "message_topic",
      "subscription",
      "topic",
      "user"
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
