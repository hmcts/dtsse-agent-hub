import type { Database } from "../store/prisma.ts";
import { AUTO_START_UNUSED_DAYS } from "./schedule.ts";
import { announce } from "./stop.ts";

/**
 * The writes of a start, shared by the owner's (`setDesired`) and the sweep's, and kept beside `stop.ts` for the same
 * reason: the store's `node:crypto` is not available where the sweep is traced.
 */

const DAY_MS = 24 * 60 * 60_000;

/**
 * Starts the agents among `ids` that are `stopped`: they become `requested` with a fresh run of claims, no stop reason,
 * disk expiry or memory report, and no client-features claim, since the next boot may run another client. A running
 * agent needs nothing and one being deleted is never brought back, so neither is touched. Inside the transaction that
 * holds the rows, because it announces each start to the owner's UI streams. Returns the agents started.
 */
export async function startVirtualAgents(db: Database, ids: readonly string[], now: Date): Promise<{ id: string; ownerOid: string }[]> {
  if (ids.length === 0) {
    return [];
  }
  const started = await db.$queryRaw<{ id: string; owner_oid: string }[]>`
    UPDATE virtual_agent
       SET desired = 'running', started_at = ${now}, stop_reason = NULL, disk_expires_at = NULL, disk_deleted_at = NULL,
           memory_limit_bytes = NULL, memory_current_bytes = NULL, memory_peak_bytes = NULL, memory_anon_bytes = NULL, memory_reported_at = NULL,
           client_features = NULL, apply_failures = 0,
           status = 'requested', status_detail = NULL, status_changed_at = ${now},
           generation = generation + 1, pod_generation = pod_generation + 1, updated_at = ${now}
     WHERE id = ANY(${[...ids]}::uuid[]) AND desired = 'stopped'
    RETURNING id::text AS id, owner_oid
  `;
  for (const row of started) {
    await announce(db, row.id, row.owner_oid);
  }
  return started.map((row) => ({ id: row.id, ownerOid: row.owner_oid }));
}

/**
 * Starts the Assistant of everyone whose auto start is `time` and who has not been auto started on `day` (a UK date),
 * and records `day` for each so it happens once a day: an agent that idles out or is stopped afterwards stays stopped.
 * The day is recorded whether or not the agent needed starting, and whether or not the person is still using it, so
 * one the person stopped a minute into the window is not started again by the next sweep.
 *
 * The Assistant is the person's first virtual agent that is not being deleted, as `findAssistant` has it. It is
 * started by `startVirtualAgents`, and only for a person who has used it within `AUTO_START_UNUSED_DAYS`: they have a
 * conversation on a pod with activity since then, which only they make. A pod's report or an earlier auto start is
 * not use, or auto start would keep itself alive. Returns the agents started.
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
  const usedSince = new Date(now.getTime() - AUTO_START_UNUSED_DAYS * DAY_MS);
  const assistants = await db.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ON (owner_oid) id::text AS id FROM virtual_agent
     WHERE owner_oid = ANY(${due.map((row) => row.owner_oid)}) AND desired <> 'deleted'
       AND EXISTS (
         SELECT 1 FROM assistant_conversation c
          WHERE c.owner_oid = virtual_agent.owner_oid AND c.virtual_agent_id IS NOT NULL AND c.last_active_at >= ${usedSince}
       )
     ORDER BY owner_oid, created_at, id
  `;
  return await startVirtualAgents(
    db,
    assistants.map((row) => row.id),
    now
  );
}

/**
 * Tries again an agent of `ownerOid`'s that is meant to be running and failed: back to `requested` with a fresh
 * generation, so an orchestrator claims and applies it as it would a start, and with none of the failed pod's token,
 * ports, memory report or client claim. `requested` rather than `provisioning`, because nothing is scheduled until an
 * orchestrator takes it — a failure that was nobody picking it up would otherwise read as a pod on its way. Whether it
 * was retried.
 */
export async function retryVirtualAgent(db: Database, ownerOid: string, id: string, now: Date): Promise<boolean> {
  const retried = await db.$queryRaw<{ id: string; owner_oid: string }[]>`
    UPDATE virtual_agent
       SET started_at = ${now}, stop_reason = NULL,
           memory_limit_bytes = NULL, memory_current_bytes = NULL, memory_peak_bytes = NULL, memory_anon_bytes = NULL, memory_reported_at = NULL,
           client_features = NULL, apply_failures = 0, exposed_ports = '{}', local_only_ports = '{}',
           launch_token_hash = NULL, launch_token_issued_at = NULL,
           status = 'requested', status_detail = NULL, status_changed_at = ${now},
           generation = generation + 1, pod_generation = pod_generation + 1, updated_at = ${now}
     WHERE id = ${id}::uuid AND owner_oid = ${ownerOid} AND desired = 'running' AND status = 'failed'
    RETURNING id::text AS id, owner_oid
  `;
  for (const row of retried) {
    await announce(db, row.id, row.owner_oid);
  }
  return retried.length > 0;
}
