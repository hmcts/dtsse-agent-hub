import { localConversationSql } from "../assistant/local-chat-store.ts";
import { notify } from "../realtime/notify.ts";
import type { Database } from "../store/prisma.ts";

/**
 * Marks the current agent of each conversation offline, and announces each one that changed as the offline sweep does.
 * For a session the pod no longer runs: its agent's `idle` is left over from the session that ran before. An agent
 * already offline is left alone, and so is one the conversation has since been given another of.
 */
export async function markConversationAgentsOffline(db: Database, conversationIds: readonly string[]): Promise<void> {
  if (conversationIds.length === 0) {
    return;
  }
  const marked = await db.$queryRaw<{ id: string; owner_oid: string; local_conversation_id: string | null }[]>`
    UPDATE agent SET status = 'offline'
     WHERE status <> 'offline' AND id IN (SELECT agent_id FROM assistant_conversation WHERE id = ANY(${[...conversationIds]}::uuid[]))
    RETURNING id::text AS id, owner_oid, ${localConversationSql("agent")} AS local_conversation_id
  `;
  for (const agent of marked) {
    await notify(db, {
      type: "agent_status",
      agent_id: agent.id,
      owner_oid: agent.owner_oid,
      status: "offline",
      local_conversation_id: agent.local_conversation_id
    });
  }
}
