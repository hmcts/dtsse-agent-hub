import { markConversationAgentsOffline } from "../agents/offline.ts";
import { announce as announceConversation } from "../assistant/conversation-row.ts";
import { notify } from "../realtime/notify.ts";
import type { Database } from "../store/prisma.ts";

/**
 * The writes the sweep shares with the store, kept apart from it because `instrumentation.ts` reaches the sweep, and
 * Next traces that into an Edge bundle too, where the store's `node:crypto` is not available.
 */

export type StopReason = "user" | "idle" | "evening" | "failed" | "awaiting_owner";

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
 * An agent not yet stopped becomes `stopping` and loses its `status_detail`, which described the pod being stopped;
 * one already `stopped` keeps its status, its detail and when its status last changed. The pod's client-features
 * claim goes either way, since the next boot may run another client.
 *
 * The assistant's conversations lose their session state and have their current agents marked offline: no session
 * outlives the pod, and a `live` left behind would keep a message from asking for the wake that starts one.
 */
export async function stopVirtualAgents(db: Database, ids: readonly string[], reason: StopReason, now: Date): Promise<{ id: string; ownerOid: string }[]> {
  if (ids.length === 0) {
    return [];
  }
  const stopped = await db.$queryRaw<{ id: string; owner_oid: string }[]>`
    UPDATE virtual_agent
       SET desired = 'stopped', stop_reason = ${reason}::virtual_agent_stop_reason, generation = generation + 1, pod_generation = pod_generation + 1,
           exposed_ports = '{}', local_only_ports = '{}', client_features = NULL,
           launch_token_hash = NULL, launch_token_issued_at = NULL, apply_failures = 0,
           status = CASE WHEN status = 'stopped' THEN status ELSE 'stopping' END,
           status_detail = CASE WHEN status = 'stopped' THEN status_detail ELSE NULL END,
           status_changed_at = CASE WHEN status = 'stopped' THEN status_changed_at ELSE ${now} END,
           updated_at = ${now}
     WHERE id = ANY(${[...ids]}::uuid[]) AND desired = 'running'
    RETURNING id::text AS id, owner_oid
  `;
  await forgetSessions(
    db,
    stopped.map((row) => row.id)
  );
  for (const row of stopped) {
    await announce(db, row.id, row.owner_oid);
  }
  return stopped.map((row) => ({ id: row.id, ownerOid: row.owner_oid }));
}

/**
 * What a stopped pod leaves on its conversations: the sessions it said they had, which it is not there to answer any
 * more. Left, a chat on a stopped pod says it is waiting for a free assistant. A wake asked for stays: it is a message
 * the person sent, answered once the assistant is started again. Their agents are marked offline with them, and each
 * conversation is announced, so a chat open on one shows it as it now is.
 */
export async function forgetSessions(db: Database, virtualAgentIds: readonly string[]): Promise<void> {
  if (virtualAgentIds.length === 0) {
    return;
  }
  const conversations = await db.$queryRaw<{ id: string; virtual_agent_id: string; owner_oid: string }[]>`
    UPDATE assistant_conversation SET session_state = NULL, session_detail = NULL
     WHERE virtual_agent_id = ANY(${[...virtualAgentIds]}::uuid[])
    RETURNING id::text AS id, virtual_agent_id::text AS virtual_agent_id, owner_oid
  `;
  await markConversationAgentsOffline(
    db,
    conversations.map((row) => row.id)
  );
  for (const row of conversations) {
    await announceConversation(db, { id: row.id, virtualAgentId: row.virtual_agent_id, ownerOid: row.owner_oid });
  }
}
