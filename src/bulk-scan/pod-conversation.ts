import { findAssistant } from "../assistant/assistant-store.ts";
import type { Database } from "../store/prisma.ts";

/**
 * The conversation the builder runs its pod jobs in. A pod job belongs to one of its owner's conversations on their
 * assistant, and the builder has none of its own, so it uses the one they used last. `null` when they have no chat on a
 * pod yet, which the builder says in words: the jobs have nowhere to run until they have started one.
 */
export async function podConversationId(db: Database, ownerOid: string): Promise<string | null> {
  const assistant = await findAssistant(db, ownerOid);
  if (assistant === undefined) {
    return null;
  }
  const conversation = await db.assistantConversation.findFirst({
    where: { ownerOid, virtualAgentId: assistant.id },
    select: { id: true },
    orderBy: [{ lastActiveAt: "desc" }, { id: "desc" }]
  });
  return conversation?.id ?? null;
}
