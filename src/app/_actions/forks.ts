"use server";

import { revalidatePath } from "next/cache";
import { acceptFork, offerFork, withdrawFork } from "@/assistant/fork-store";
import { CHAT_BLOCKED } from "@/assistant/onboarding";
import type { SharePerson } from "@/assistant/shares";
import { prisma } from "@/store/prisma";
import { requireViewer } from "@/viewer/current";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { type ActionResult, runAction, text } from "@/web/action";
import { assistantChatGate } from "@/web/data";

/**
 * Offering one of the signed-in person's own conversations to one person they named, to fork; withdrawing that
 * offer; and, for the person offered it, taking their own copy. The owner and the recipient are both the session's
 * identity rather than anything in the argument, so nobody can offer another owner's chat or take a copy offered to
 * someone else; the store reports either as a conversation that is missing.
 */

const OFF: { ok: false; error: string } = { ok: false, error: "the HMCTS Assistant is not available on this deployment" };

export async function offerChatFork(input: { conversationId: unknown; recipientOid: unknown }): Promise<ActionResult<{ people: SharePerson[] }>> {
  return await runAction<{ people: SharePerson[] }>("offer chat fork", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const recipientOid = text(input.recipientOid);
    if (recipientOid === "") {
      return { ok: false, error: "choose the person to offer it to" };
    }
    const conversationId = text(input.conversationId);
    const people = await offerFork(prisma, viewer.oid, conversationId, recipientOid);
    revalidatePath("/assistant/shared");
    revalidatePath(`/assistant/${conversationId}`);
    return { ok: true, people };
  });
}

export async function withdrawChatFork(input: { conversationId: unknown; recipientOid: unknown }): Promise<ActionResult<{ people: SharePerson[] }>> {
  return await runAction<{ people: SharePerson[] }>("withdraw chat fork", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const recipientOid = text(input.recipientOid);
    if (recipientOid === "") {
      return { ok: false, error: "no offer was named" };
    }
    const conversationId = text(input.conversationId);
    const people = await withdrawFork(prisma, viewer.oid, conversationId, recipientOid);
    revalidatePath("/assistant/shared");
    revalidatePath(`/assistant/${conversationId}`);
    return { ok: true, people };
  });
}

/**
 * Takes the viewer's own copy of a chat offered to them, and answers the copy's id for the page to go to. A copy is a
 * new conversation of the viewer's, so it is behind the same gate as starting one: someone who has yet to connect
 * GitHub and Claude would only be taken to a chat the getting-ready screen holds them out of.
 */
export async function forkChat(input: { conversationId: unknown }): Promise<ActionResult<{ id: string }>> {
  return await runAction<{ id: string }>("fork chat", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    if ((await assistantChatGate(viewer)) === "blocked") {
      return { ok: false, error: CHAT_BLOCKED };
    }
    const conversationId = text(input.conversationId);
    const id = await acceptFork(prisma, viewer, conversationId);
    revalidatePath("/assistant");
    revalidatePath(`/assistant/shared/${conversationId}`);
    return { ok: true, id };
  });
}
