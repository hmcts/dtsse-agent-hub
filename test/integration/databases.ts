import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Environment } from "../../src/store/database-url.ts";

/**
 * The database each worker of an integration run writes to. Every file truncates every table, so two files sharing
 * one database would empty each other's rows mid-test, and a database is the unit that isolates what Postgres scopes
 * per database rather than per connection: `LISTEN`/`NOTIFY`, and the advisory locks the sweeps take.
 *
 * The names are stable, and the suite never drops them: `DROP DATABASE` forces a checkpoint, and a run that dropped
 * one per worker spent longer waiting on checkpoints than running tests. They are reused instead, migrated on use
 * and truncated per test, so only the first run on a checkout pays to create them.
 */

/**
 * Identifies the checkout, so the main clone and each worktree get their own set rather than truncating each other's
 * tables. Two runs of the *same* checkout at once still share them; that is what `DATABASE_URL` is for.
 */
function checkout(): string {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  return createHash("sha1").update(root).digest("hex").slice(0, 8);
}

/**
 * The server, and the stem the worker names are built from. Nothing writes to the database it names: an explicit
 * `DATABASE_URL`, as the pipeline sets, picks the server and the stem, and each worker takes a name under it.
 */
export const DEFAULT_DATABASE_URL = "postgresql://hmcts@localhost:5432/agent_hub_test";

export function stemUrl(env: Environment): string {
  return env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

export function workerDatabase(env: Environment): { url: string; name: string } {
  const url = new URL(stemUrl(env));
  const stem = decodeURIComponent(url.pathname.slice(1));
  // 1-based, and the same for every file a worker runs; `VITEST_WORKER_ID` counts files, not workers.
  const worker = env.VITEST_POOL_ID ?? "1";
  const name = `${stem}_${checkout()}_w${worker}`;
  url.pathname = `/${name}`;
  return { url: url.toString(), name };
}
