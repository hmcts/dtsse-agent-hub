import type { Database } from "../store/prisma.ts";
import type { Identity } from "./identity.ts";

/**
 * Records a person, or refreshes what we know of them.
 *
 * Called on every web sign-in and every authenticated agent request. The update is skipped unless something
 * changed or the row is more than five minutes stale, so a heartbeat every 30 seconds is not a write every 30
 * seconds.
 */
export async function upsertUser(db: Database, identity: Identity): Promise<void> {
  const email = identity.email ?? null;
  await db.$executeRaw`
    INSERT INTO "user" (oid, tid, name, email)
    VALUES (${identity.oid}, ${identity.tid}, ${identity.name}, ${email})
    ON CONFLICT (oid) DO UPDATE
      SET tid = EXCLUDED.tid, name = EXCLUDED.name, email = EXCLUDED.email, last_seen_at = now()
      WHERE "user".last_seen_at < now() - interval '5 minutes'
         OR "user".tid IS DISTINCT FROM EXCLUDED.tid
         OR "user".name IS DISTINCT FROM EXCLUDED.name
         OR "user".email IS DISTINCT FROM EXCLUDED.email
  `;
}

export interface KnownUser {
  oid: string;
  name: string;
  email: string | null;
  tid: string;
}

/** Everyone the hub knows at this address, matched without regard to case. Entra does not promise one per address. */
export async function usersByEmail(db: Database, email: string): Promise<KnownUser[]> {
  return await db.$queryRaw<KnownUser[]>`
    SELECT oid, name, email, tid FROM "user" WHERE lower(email) = lower(${email.trim()}) ORDER BY oid
  `;
}

/** The characters `LIKE` reads as pattern rather than text, so a typed `%` matches a literal one. */
function literal(value: string): string {
  return value.toLowerCase().replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * People the hub knows whose name starts a word with `query`, or whose address starts with it, nearest the start of
 * the name first. A search, never a list: `peopleLookup` in `src/access/rules.ts` is what decides that a query is
 * specific enough to answer at all and how many people one answer may carry.
 *
 * A word prefix rather than a substring, so "nor" finds Linus Norton without "or" finding everyone.
 */
export async function searchUsers(db: Database, query: string, limit: number): Promise<KnownUser[]> {
  const starts = `${literal(query)}%`;
  const word = `% ${literal(query)}%`;
  return await db.$queryRaw<KnownUser[]>`
    SELECT oid, name, email, tid
      FROM "user"
     WHERE lower(name) LIKE ${starts} OR lower(name) LIKE ${word} OR lower(coalesce(email, '')) LIKE ${starts}
     ORDER BY lower(name), oid
     LIMIT ${limit}
  `;
}
