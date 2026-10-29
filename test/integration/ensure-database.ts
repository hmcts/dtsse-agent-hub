import pg from "pg";

const INVALID_CATALOG_NAME = "3D000";
const DUPLICATE_DATABASE = "42P04";
const TOO_MANY_CONNECTIONS = "53300";

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

/** What to tell someone whose connection failed, by the reason it failed. */
function advice(code: string | undefined, url: string): string {
  const where = new URL(url).host;
  if (code === TOO_MANY_CONNECTIONS) {
    return `Postgres at ${where} is out of connections. Each worker holds a pool of 10, so lower INTEGRATION_WORKERS or raise the server's max_connections.`;
  }
  // Deliberately not the URL: an explicit `DATABASE_URL` may carry a password.
  return `Integration tests need Postgres at ${where}. Start it with \`yarn deps:up\`.`;
}

/** Checks the server is there, and creates the database if it is the one thing missing. */
export async function ensureDatabase(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    const { code } = error as { code?: string };
    if (code !== INVALID_CATALOG_NAME) {
      throw new Error(`${advice(code, url)}\n\nUnderlying error: ${(error as Error).message}`);
    }
    await createDatabase(url);
  } finally {
    await client.end().catch(() => undefined);
  }
}
