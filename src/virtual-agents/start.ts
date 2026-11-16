import type { Database } from "../store/prisma.ts";
import { announce } from "./stop.ts";

/**
 * The sweep's start, kept beside `stop.ts` for the same reason: the store's `node:crypto` is not available where the
 * sweep is traced.
 */

/**
 * Starts the Assistant of everyone whose auto start is `time` and who has not been auto started on `day` (a UK date),
 * and records `day` for each so it happens once a day: an agent that idles out or is stopped afterwards stays stopped.
 * The day is recorded whether or not the agent needed starting, so one the person stopped a minute into the window is
 * not started again by the next sweep.
 *
 * The Assistant is the person's first virtual agent that is not being deleted, as `findAssistant` has it. It is started
 * only when `stopped`, with the writes `setDesired(…, "running")` makes: a running one needs nothing, and one being
 * deleted is never brought back. Returns the agents started.
 */
export async function autoStartAssistants(db: Database, time: string, day: string, now: Date): Promise<{ id: string; ownerOid: string }[]> {
  const due = await db.$queryRaw<{ owner_oid: string }[]>`
    UPDATE assistant_schedule
       SET last_auto_start_on = ${day}::date
     WHERE auto_start_time = ${time} AND (last_auto_start_on IS NULL OR last_auto_start_on <> ${day}::date)
    RETURNING owner_oid
  `;
  if (due.length === 0) {
    return [];
  }
  const started = await db.$queryRaw<{ id: string; owner_oid: string }[]>`
    UPDATE virtual_agent
       SET desired = 'running', started_at = ${now}, stop_reason = NULL, disk_expires_at = NULL, disk_deleted_at = NULL,
           memory_limit_bytes = NULL, memory_current_bytes = NULL, memory_peak_bytes = NULL, memory_anon_bytes = NULL, memory_reported_at = NULL,
           client_features = NULL, apply_failures = 0,
           status = 'requested', status_detail = NULL, status_changed_at = ${now},
           generation = generation + 1, pod_generation = pod_generation + 1, updated_at = ${now}
     WHERE desired = 'stopped'
       AND id IN (
         SELECT DISTINCT ON (owner_oid) id FROM virtual_agent
          WHERE owner_oid = ANY(${due.map((row) => row.owner_oid)}) AND desired <> 'deleted'
          ORDER BY owner_oid, created_at, id
       )
    RETURNING id::text AS id, owner_oid
  `;
  for (const row of started) {
    await announce(db, row.id, row.owner_oid);
  }
  return started.map((row) => ({ id: row.id, ownerOid: row.owner_oid }));
}
