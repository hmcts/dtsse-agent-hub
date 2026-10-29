import pg from "pg";
import { stemUrl } from "./databases.ts";

/**
 * Fails the run once, with the reason, if Postgres is not there — rather than letting every worker discover it
 * separately. It creates nothing: each worker creates and migrates a database of its own in `worker-database.ts`,
 * and nothing writes to the database the configured URL names.
 *
 * The check goes through the server's `postgres` database, which every Postgres server has.
 */
export default async function setup(): Promise<void> {
  const server = new URL(stemUrl(process.env));
  server.pathname = "/postgres";
  const client = new pg.Client({ connectionString: server.toString() });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(`Integration tests need Postgres at ${server.host}. Start it with \`yarn deps:up\`.\n\nUnderlying error: ${(error as Error).message}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}
