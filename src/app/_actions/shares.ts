"use server";

import { revalidatePath } from "next/cache";
import { type SharePerson, shareConversation, unshareConversation } from "@/assistant/shares";
import { prisma } from "@/store/prisma";
import { requireViewer } from "@/viewer/current";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { type ActionResult, runAction, text } from "@/web/action";

/**
 * Sharing one of the signed-in person's own conversations, read-only, with one person they named, and taking that
 * share back. The owner is the session's identity rather than anything in the argument, so nobody can change who
 * another owner's chat is shared with; `shareConversation` reports a conversation that is not theirs as missing.
 */

const OFF: { ok: false; error: string } = { ok: false, error: "the HMCTS Assistant is not available on this deployment" };

export async function shareChat(input: { conversationId: unknown; recipientOid: unknown }): Promise<ActionResult<{ people: SharePerson[] }>> {
  return await runAction<{ people: SharePerson[] }>("share chat", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const recipientOid = text(input.recipientOid);
    if (recipientOid === "") {
      return { ok: false, error: "choose the person to share with" };
    }
    const conversationId = text(input.conversationId);
    const people = await shareConversation(prisma, viewer.oid, conversationId, recipientOid);
    revalidatePath("/assistant/shared");
    revalidatePath(`/assistant/${conversationId}`);
    return { ok: true, people };
  });
}

export async function unshareChat(input: { conversationId: unknown; recipientOid: unknown }): Promise<ActionResult<{ people: SharePerson[] }>> {
  return await runAction<{ people: SharePerson[] }>("unshare chat", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const recipientOid = text(input.recipientOid);
    if (recipientOid === "") {
      return { ok: false, error: "no share was named" };
    }
    const conversationId = text(input.conversationId);
    const people = await unshareConversation(prisma, viewer.oid, conversationId, recipientOid);
    revalidatePath("/assistant/shared");
    revalidatePath(`/assistant/${conversationId}`);
    return { ok: true, people };
  });
}
