/**
 * Assembles `DATABASE_URL` the way every CFT Node service does: from the `POSTGRES_*` parts the chart mounts out of
 * the Key Vault, falling back to the local compose default. An explicit `DATABASE_URL` wins over the fallback, which
 * is how a test run points at a scratch database. Deployed, `sslmode=require` is mandatory: the flexible server
 * refuses an unencrypted connection.
 */

/** A plain string map rather than `NodeJS.ProcessEnv`, which Next augments to make `NODE_ENV` required. */
export type Environment = Record<string, string | undefined>;

export const LOCAL_DATABASE_URL = "postgresql://hmcts@localhost:5432/agent_hub";

export interface MountedParts {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

export function mountedDatabaseParts(env: Environment): MountedParts | undefined {
  const { POSTGRES_HOST, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_PORT, POSTGRES_DATABASE } = env;
  return POSTGRES_HOST && POSTGRES_USER && POSTGRES_PASSWORD && POSTGRES_PORT && POSTGRES_DATABASE
    ? { host: POSTGRES_HOST, port: POSTGRES_PORT, user: POSTGRES_USER, password: POSTGRES_PASSWORD, database: POSTGRES_DATABASE }
    : undefined;
}

export function resolveDatabaseUrl(env: Environment = process.env): string {
  const parts = mountedDatabaseParts(env);
  return parts === undefined
    ? (env.DATABASE_URL ?? LOCAL_DATABASE_URL)
    : `postgresql://${encodeURIComponent(parts.user)}:${encodeURIComponent(parts.password)}@${parts.host}:${parts.port}/${parts.database}?sslmode=require`;
}

/** Sets `DATABASE_URL` in the environment, for Prisma's own CLI and generated client to read. */
export function applyDatabaseUrl(env: Environment = process.env): string {
  const url = resolveDatabaseUrl(env);
  env.DATABASE_URL = url;
  return url;
}
