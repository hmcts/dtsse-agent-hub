import { loadThreadMessage, type ThreadMessage } from "../messages/direct-thread.ts";
import { directAsPerson } from "../messages/send.ts";
import type { NewDirect } from "../messages/store.ts";
import type { PrismaClient } from "../store/prisma.ts";
import type { ConversationRow } from "./conversation-row.ts";
import { conversationAgent, touchConversation } from "./conversation-store.ts";
import { requestWake, wakeConversationPod } from "./session-store.ts";
import { needsWake } from "./wake.ts";

/**
 * A message from the person into one of their own conversations, through the same `directAsPerson` as the hub's
 * composer: an ordinary direct message to the conversation's agent, so it queues as a delivery while no session runs
 * and the pod's wake is what starts one. A conversation with no pod has nothing to wake and `requestWake` does
 * nothing for one; the delivery waits on the stream the laptop's session opens when it comes back.
 *
 * Its own module rather than a function in `src/app/_actions/assistant.ts`, because everything exported from a
 * `"use server"` file is reachable as a server action, and more than one action sends into a conversation — the
 * composer's, and answering a question the session asked.
 */

export interface ConversationMessage {
  body: string;
  /** What the conversation is titled after while it has no title of its own; usually the body. */
  title: string;
  /** `NewDirect`'s: work that shares the message's transaction, which the Assistant attaches files in. */
  alongside?: NewDirect["alongside"];
}

export async function sendToConversation(
  prisma: PrismaClient,
  senderOid: string,
  conversation: ConversationRow,
  message: ConversationMessage
): Promise<ThreadMessage> {
  // Touched first, so the chat reads as in use before its message goes: the sweep of empty chats passes over one
  // active since its window began, and holds the row while it decides, so a first message is never swept from under
  // the person. A chat the sweep has already removed fails here, and the person keeps what they typed.
  await touchConversation(prisma, conversation, message.title);
  const agentId = await conversationAgent(prisma, conversation);
  const sent = await directAsPerson(prisma, senderOid, agentId, message.body, message.alongside);
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { status: true } });
  if (needsWake(agent?.status, conversation.sessionState)) {
    // One wake at a time is asked of the session, but the pod is brought back however many have been: a message to a
    // stopped or failed pod with a wake already pending would otherwise wait on a pod nothing starts.
    if (conversation.wakeRequestedAt === null) {
      await requestWake(prisma, conversation);
    } else {
      await wakeConversationPod(prisma, conversation);
    }
  }
  const loaded = await loadThreadMessage(prisma, BigInt(sent.id));
  return loaded?.message ?? { ...sent, delivery: "queued" };
}
