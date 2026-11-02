import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { byCodePoint } from "../topics/slug.ts";
import { resolveDatabaseUrl } from "./database-url.ts";

/**
 * Applies the hand-written migrations under `prisma/migrations`, recording each in the same `_prisma_migrations`
 * ledger `prisma migrate` keeps, so either tool sees the other's work.
 *
 * Run by the image before the server starts. Several pods can boot at once, so the whole run holds a session
 * advisory lock on a dedicated connection; a pod that waits finds nothing left to apply.
 */

const LEDGER = `
  CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                    VARCHAR(36)  PRIMARY KEY NOT NULL,
    "checksum"              VARCHAR(64)  NOT NULL,
    "finished_at"           TIMESTAMPTZ,
    "migration_name"        VARCHAR(255) NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        TIMESTAMPTZ,
    "started_at"            TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "applied_steps_count"   INTEGER      NOT NULL DEFAULT 0
  )
`;

/** "agnthubm". Distinct from the offline sweep's key, so a boot and a sweep do not exclude each other. */
const LOCK_KEY = 0x61676e74_6875626dn;

interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

const CONNECT_TIMEOUT_MS = 120_000;
const CONNECT_RETRY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 57P03 is Postgres's cannot_connect_now: up, but still starting, recovering or shutting down. */
const STARTING_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "57P03"]);

/** Whether a connect failure is one of a database that is still starting. Any other answer from Postgres is final. */
export function isStartingError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === "string" && STARTING_CODES.has(code)) {
    return true;
  }
  // pg raises this with no code when the server closes the socket mid-handshake, as a restarting server does.
  return typeof message === "string" && message.includes("Connection terminated unexpectedly");
}

/** Retries only the errors `isStartingError` accepts, until the deadline. */
async function connectWhenReady(connectionString: string, pause: (ms: number) => Promise<void>): Promise<pg.Client> {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;

  for (;;) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end().catch(() => undefined);
      if (!isStartingError(error) || Date.now() >= deadline) {
        throw error;
      }
      console.info(`waiting for the database: ${error instanceof Error ? error.message : String(error)}`);
      await pause(CONNECT_RETRY_MS);
    }
  }
}

export function migrationsDirectory(cwd: string = process.cwd()): string {
  return path.join(cwd, "prisma", "migrations");
}

async function readMigrations(directory: string): Promise<Migration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(byCodePoint);

  const migrations: Migration[] = [];
  for (const name of names) {
    const sql = await readFile(path.join(directory, name, "migration.sql"), "utf8");
    migrations.push({ name, sql, checksum: createHash("sha256").update(sql).digest("hex") });
  }
  return migrations;
}

/** The checksum recorded for each applied migration, by name. */
async function applied(client: pg.ClientBase): Promise<Map<string, string>> {
  const { rows } = await client.query<{ migration_name: string; checksum: string }>(
    `SELECT migration_name, checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`
  );
  return new Map(rows.map((row) => [row.migration_name, row.checksum]));
}

/** An edited applied migration never reruns, so the schema would silently disagree with its source. */
function assertUnchanged(migrations: readonly Migration[], done: ReadonlyMap<string, string>): void {
  for (const migration of migrations) {
    const recorded = done.get(migration.name);
    if (recorded !== undefined && recorded !== migration.checksum) {
      throw new Error(
        `migration ${migration.name} has changed since it was applied: the ledger records checksum ${recorded}, the file's is ${migration.checksum}. Restore the file and make the change in a new migration.`
      );
    }
  }
}

/** Applies every pending migration, each in its own transaction, and returns the names applied. */
export async function migrate(directory: string = migrationsDirectory(), pause: (ms: number) => Promise<void> = sleep): Promise<string[]> {
  const migrations = await readMigrations(directory);
  const client = await connectWhenReady(resolveDatabaseUrl(), pause);

  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY.toString()]);
    await client.query(LEDGER);
    const done = await applied(client);
    assertUnchanged(migrations, done);
    const pending = migrations.filter((migration) => !done.has(migration.name));

    for (const migration of pending) {
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
           VALUES ($1, $2, $3, now(), now(), 1)`,
          [randomUUID(), migration.checksum, migration.name]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }

    return pending.map((migration) => migration.name);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY.toString()]).catch(() => undefined);
    await client.end();
  }
}
