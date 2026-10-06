import { notify } from "../realtime/notify.ts";
import type { Database } from "../store/prisma.ts";

/**
 * The writes the sweep shares with the store, kept apart from it because `instrumentation.ts` reaches the sweep, and
 * Next traces that into an Edge bundle too, where the store's `node:crypto` is not available.
 */

export type StopReason = "user" | "idle" | "evening" | "quota" | "expired" | "failed";

/** Tells the owner's UI streams that one of their virtual agents changed. Inside the transaction that changed it. */
export async function announce(db: Database, virtualAgentId: string, ownerOid: string): Promise<void> {
  await notify(db, { type: "virtual_agent", virtual_agent_id: virtualAgentId, owner_oid: ownerOid });
}

/** The sweep's stop: as the owner's, but for a reason of its own, and only of agents still meant to be running. */
export async function stopVirtualAgents(db: Database, ids: readonly string[], reason: StopReason, now: Date): Promise<{ id: string; ownerOid: string }[]> {
  if (ids.length === 0) {
    return [];
  }
  const stopped = await db.$queryRaw<{ id: string; owner_oid: string }[]>`
    UPDATE virtual_agent
       SET desired = 'stopped', stop_reason = ${reason}::virtual_agent_stop_reason, generation = generation + 1,
           launch_token_hash = NULL, launch_token_issued_at = NULL, apply_failures = 0,
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
