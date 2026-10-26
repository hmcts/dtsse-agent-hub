import { notify } from "../realtime/notify.ts";
import type { Database } from "../store/prisma.ts";

/**
 * The writes the sweep shares with the store, kept apart from it because `instrumentation.ts` reaches the sweep, and
 * Next traces that into an Edge bundle too, where the store's `node:crypto` is not available.
 */

export type StopReason = "user" | "idle" | "evening" | "quota" | "expired" | "failed" | "awaiting_owner";

/** Tells the owner's UI streams that one of their virtual agents changed. Inside the transaction that changed it. */
export async function announce(db: Database, virtualAgentId: string, ownerOid: string): Promise<void> {
  await notify(db, { type: "virtual_agent", virtual_agent_id: virtualAgentId, owner_oid: ownerOid });
}

/**
 * The sweep's stop: as the owner's, but for a reason of its own, and only of agents still meant to be running.
 *
 * `desired` is what stops the agent — the orchestrator takes the StatefulSet to no replicas on seeing it — and the
 * launch token goes with it, so the pod is shut out before it is shut down and cannot report its way back out of a
 * stop the sweep decided on.
 *
 * A failed agent's `status_detail` is carried to `stop_detail` on the way, because it says why the agent failed and
 * that is still true with its pod gone. Nothing else survives: the status becomes `stopping`, and the orchestrator's
 * observation of the stopped StatefulSet clears the detail with the pod it described.
 */
export async function stopVirtualAgents(db: Database, ids: readonly string[], reason: StopReason, now: Date): Promise<{ id: string; ownerOid: string }[]> {
  if (ids.length === 0) {
    return [];
  }
  const stopped = await db.$queryRaw<{ id: string; owner_oid: string }[]>`
    UPDATE virtual_agent
       SET desired = 'stopped', stop_reason = ${reason}::virtual_agent_stop_reason, generation = generation + 1, pod_generation = pod_generation + 1,
           exposed_ports = '{}', local_only_ports = '{}',
           launch_token_hash = NULL, launch_token_issued_at = NULL, apply_failures = 0,
           stop_detail = CASE WHEN status = 'failed' THEN status_detail ELSE NULL END,
           status = CASE WHEN status = 'stopped' THEN status ELSE 'stopping' END,
           status_detail = CASE WHEN status = 'stopped' THEN status_detail ELSE NULL END,
           status_changed_at = CASE WHEN status = 'stopped' THEN status_changed_at ELSE ${now} END,
           updated_at = ${now}
     WHERE id = ANY(${[...ids]}::uuid[]) AND desired = 'running'
    RETURNING id::text AS id, owner_oid
  `;
  for (const row of stopped) {
    await announce(db, row.id, row.owner_oid);
  }
  return stopped.map((row) => ({ id: row.id, ownerOid: row.owner_oid }));
}
