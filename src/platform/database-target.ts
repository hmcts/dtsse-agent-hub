import { type Environment, LOCAL_DATABASE_URL, mountedDatabaseParts } from "../store/database-url.ts";

/** Narrow on purpose: anything that does not read as `host:port/database` is withheld rather than printed. */
const TARGET = /^[a-z0-9._-]{1,253}:\d{1,5}\/[a-z0-9_$.-]{1,63}$/i;

const UNRECOGNISED = "an unrecognised database target";

/** Where a process is about to connect, as `host:port/database`, never with the credential. */
export function describeDatabase(env: Environment = process.env): string {
  const parts = mountedDatabaseParts(env);
  const described = parts === undefined ? describeUrl(env.DATABASE_URL ?? LOCAL_DATABASE_URL) : `${parts.host}:${parts.port}/${parts.database}`;
  return TARGET.test(described) ? described : UNRECOGNISED;
}

function describeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const port = parsed.port === "" ? "5432" : parsed.port;
    return `${parsed.hostname}:${port}/${parsed.pathname.replace(/^\//, "")}`;
  } catch {
    return "";
  }
}
