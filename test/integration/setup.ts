import pg from "pg";
import type { TestProject } from "vitest/node";
import { migrate } from "../../src/store/migrate.ts";

const INVALID_CATALOG_NAME = "3D000";

/** Creates the database through the server's `postgres` database, which every Postgres server has. */
async function createDatabase(url: string): Promise<void> {
  const server = new URL(url);
  const name = decodeURIComponent(server.pathname.slice(1));
  server.pathname = "/postgres";
  const client = new pg.Client({ connectionString: server.toString() });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
  } finally {
    await client.end();
  }
}

async function ensureDatabase(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    if ((error as { code?: string }).code !== INVALID_CATALOG_NAME) {
      throw error;
    }
    await createDatabase(url);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Checks the server is there, creates the suite's database on it if it is missing, and brings its schema up to date,
 * so no suite depends on a manual migrate. This runs in the main process, which `test.env` does not reach, so the URL
 * comes from the project config and reaches `migrate` through the environment.
 */
export default async function setup(project: TestProject): Promise<void> {
  const url = project.config.env.DATABASE_URL;
  if (url === undefined) {
    throw new Error("vitest.integration.config.mts must set test.env.DATABASE_URL");
  }
  try {
    await ensureDatabase(url);
  } catch (error) {
    throw new Error(`Integration tests need Postgres at ${url}. Start it with \`yarn deps:up\`.\n\nUnderlying error: ${(error as Error).message}`);
  }
  process.env.DATABASE_URL = url;
  await migrate();
}
