import pg from "pg";
import { LOCAL_DATABASE_URL } from "../../src/store/database-url.ts";
import { migrate } from "../../src/store/migrate.ts";

/** Checks the database is there and brings its schema up to date, so no suite depends on a manual migrate. */
export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(`Integration tests need Postgres at ${url}. Start it with \`yarn deps:up\`.\n\nUnderlying error: ${(error as Error).message}`);
  } finally {
    await client.end().catch(() => undefined);
  }
  await migrate();
}
