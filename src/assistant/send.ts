import { loadThreadMessage, type ThreadMessage } from "../messages/direct-thread.ts";
import { directAsPerson } from "../messages/send.ts";
import type { NewDirect } from "../messages/store.ts";
import type { PrismaClient } from "../store/prisma.ts";
import { type ConversationRow, conversationAgent, requestWake, touchConversation } from "./store.ts";

/**
 * A message from the person into one of their own conversations, through the same `directAsPerson` as the hub's
 * composer: an ordinary direct message to the conversation's agent, so it queues as a delivery while no session runs
 * and the pod's wake is what starts one.
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
  const agentId = await conversationAgent(prisma, conversation);
  const sent = await directAsPerson(prisma, senderOid, agentId, message.body, message.alongside);
  await touchConversation(prisma, conversation, message.title);
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { status: true } });
  if (agent?.status !== "busy" && agent?.status !== "idle") {
    await requestWake(prisma, conversation);
  }
  const loaded = await loadThreadMessage(prisma, BigInt(sent.id));
  return loaded?.message ?? { ...sent, delivery: "queued" };
}
