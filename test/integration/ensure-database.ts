import pg from "pg";

const INVALID_CATALOG_NAME = "3D000";
const DUPLICATE_DATABASE = "42P04";

/** Creates the database through the server's `postgres` database, which every Postgres server has. */
async function createDatabase(url: string): Promise<void> {
  const server = new URL(url);
  const name = decodeURIComponent(server.pathname.slice(1));
  server.pathname = "/postgres";
  const client = new pg.Client({ connectionString: server.toString() });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
  } catch (error) {
    // Two workers can reach this for their own databases at once, and Postgres serialises the creates; a duplicate
    // means another one of them won, which is the result this wanted.
    if ((error as { code?: string }).code !== DUPLICATE_DATABASE) {
      throw error;
    }
  } finally {
    await client.end();
  }
}

/** Checks the server is there, and creates the database if it is the one thing missing. */
export async function ensureDatabase(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    if ((error as { code?: string }).code !== INVALID_CATALOG_NAME) {
      throw new Error(`Integration tests need Postgres at ${url}. Start it with \`yarn deps:up\`.\n\nUnderlying error: ${(error as Error).message}`);
    }
    await createDatabase(url);
  } finally {
    await client.end().catch(() => undefined);
  }
}
