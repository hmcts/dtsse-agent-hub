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
