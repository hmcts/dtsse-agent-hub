"use server";

import { revalidatePath } from "next/cache";
import { MAX_ARTEFACT_MARKDOWN, MAX_ARTEFACT_TITLE } from "@/assistant/schemas";
import {
  type Artefact,
  ArtefactConflict,
  type ConversationRow,
  conversationAgent,
  createConversation,
  findConversation,
  deleteConversation as remove,
  renameConversation as rename,
  requestWake,
  setProduct,
  touchConversation,
  writeArtefact
} from "@/assistant/store";
import { attachUploads } from "@/assistant/upload-store";
import { loadThreadMessage, type ThreadMessage } from "@/messages/direct-thread";
import { MAX_BODY } from "@/messages/limits";
import { directAsPerson } from "@/messages/send";
import { prisma } from "@/store/prisma";
import { requireViewer } from "@/viewer/current";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { type ActionResult, runAction, text } from "@/web/action";

/**
 * The HMCTS Assistant's writes, each for the signed-in person's own conversations only: `findConversation` reports
 * anyone else's as missing. A message is an ordinary direct message to the conversation's agent, through the same
 * `directAsPerson` as the hub's composer, followed by a wake when no session is running for it.
 */

// The Assistant runs on a virtual agent, so it is available exactly where they are.
const OFF: { ok: false; error: string } = { ok: false, error: "the HMCTS Assistant is not available on this deployment" };

const MISSING: { ok: false; error: string } = { ok: false, error: "that conversation no longer exists" };

function checkBody(raw: unknown): string | { ok: false; error: string } {
  const body = typeof raw === "string" ? raw : "";
  if (body.trim() === "") {
    return { ok: false, error: "write something to send" };
  }
  if (body.length > MAX_BODY) {
    return { ok: false, error: `a message is at most ${MAX_BODY} characters` };
  }
  return body;
}

/**
 * The upload ids an argument carries, as the composer sends them. Anything that is not a string is dropped here, and
 * every id is checked against the conversation in `attachUploads` — nothing in this list is trusted.
 */
function uploadIdsOf(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
}

async function send(oid: string, conversation: ConversationRow, body: string, uploadIds: readonly string[] = []): Promise<ThreadMessage> {
  const agentId = await conversationAgent(prisma, conversation);
  // Attached inside the message's own transaction: an id that is not this person's, is not this conversation's, is
  // not finished uploading, or is already on another message refuses the whole send, and no message is written.
  const sent = await directAsPerson(prisma, oid, agentId, body, async (tx, messageId) => {
    await attachUploads(tx, { viewerOid: oid, conversationId: conversation.id, messageId, uploadIds });
  });
  await touchConversation(prisma, conversation, body);
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { status: true } });
  if (agent?.status !== "busy" && agent?.status !== "idle") {
    await requestWake(prisma, conversation);
  }
  const loaded = await loadThreadMessage(prisma, BigInt(sent.id));
  return loaded?.message ?? { ...sent, delivery: "queued" };
}

/** A new conversation, started with its first message: a starter card's prompt, or what the person typed. */
export async function startConversation(input: { product: unknown; body: unknown }): Promise<ActionResult<{ id: string }>> {
  return await runAction<{ id: string }>("start conversation", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const body = checkBody(input.body);
    if (typeof body !== "string") {
      return body;
    }
    const conversation = await createConversation(prisma, viewer.oid, { product: input.product });
    await send(viewer.oid, conversation, body);
    revalidatePath("/assistant");
    return { ok: true, id: conversation.id };
  });
}

/** `uploadIds` is optional, so a caller that attaches nothing sends exactly as before. */
export async function sendAssistantMessage(input: {
  conversationId: unknown;
  body: unknown;
  uploadIds?: unknown;
}): Promise<ActionResult<{ message: ThreadMessage }>> {
  return await runAction<{ message: ThreadMessage }>("assistant message", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const body = checkBody(input.body);
    if (typeof body !== "string") {
      return body;
    }
    const conversation = await findConversation(prisma, viewer.oid, text(input.conversationId));
    if (conversation === undefined) {
      return MISSING;
    }
    return { ok: true, message: await send(viewer.oid, conversation, body, uploadIdsOf(input.uploadIds)) };
  });
}

/** Asks for a session before the person has finished typing, so the first answer comes sooner. Says nothing back. */
export async function warmConversation(input: { conversationId: unknown }): Promise<ActionResult> {
  return await runAction("warm conversation", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const conversation = await findConversation(prisma, viewer.oid, text(input.conversationId));
    if (conversation === undefined) {
      return MISSING;
    }
    const agentId = await conversationAgent(prisma, conversation);
    const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { status: true } });
    if (agent?.status === "offline" && conversation.wakeRequestedAt === null) {
      await requestWake(prisma, conversation);
    }
    return { ok: true };
  });
}

export async function setConversationProduct(input: { conversationId: unknown; product: unknown }): Promise<ActionResult> {
  return await runAction("set conversation product", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    await setProduct(prisma, viewer.oid, text(input.conversationId), input.product);
    return { ok: true };
  });
}

export async function renameConversation(input: { conversationId: unknown; title: unknown }): Promise<ActionResult> {
  return await runAction("rename conversation", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    await rename(prisma, viewer.oid, text(input.conversationId), text(input.title));
    revalidatePath("/assistant");
    return { ok: true };
  });
}

export async function deleteConversation(input: { conversationId: unknown }): Promise<ActionResult> {
  return await runAction("delete conversation", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    await remove(prisma, viewer.oid, text(input.conversationId));
    revalidatePath("/assistant");
    return { ok: true };
  });
}

export interface ArtefactSnapshot {
  title: string | null;
  markdown: string;
  version: number;
  updatedBy: Artefact["updatedBy"];
}

export type SaveArtefactResult = { saved: true; version: number } | { saved: false; current: ArtefactSnapshot };

/**
 * The person's edit of the conversation's document, if nobody has changed it since `baseVersion`. Otherwise nothing
 * is saved and the current document comes back, for the panel to offer it or to overwrite it.
 */
export async function saveArtefact(input: {
  conversationId: unknown;
  title: unknown;
  markdown: unknown;
  baseVersion: unknown;
}): Promise<ActionResult<SaveArtefactResult>> {
  return await runAction<SaveArtefactResult>("save artefact", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const markdown = typeof input.markdown === "string" ? input.markdown.replace(/\r\n?/g, "\n") : "";
    if (markdown.length > MAX_ARTEFACT_MARKDOWN) {
      return { ok: false, error: `a document is at most ${MAX_ARTEFACT_MARKDOWN.toLocaleString("en-GB")} characters` };
    }
    const title = text(input.title).slice(0, MAX_ARTEFACT_TITLE) || null;
    const baseVersion = typeof input.baseVersion === "number" && Number.isInteger(input.baseVersion) && input.baseVersion >= 0 ? input.baseVersion : 0;
    const conversation = await findConversation(prisma, viewer.oid, text(input.conversationId));
    if (conversation === undefined) {
      return MISSING;
    }
    try {
      const version = await writeArtefact(prisma, conversation, { title, markdown, baseVersion, by: "user" });
      return { ok: true, saved: true, version };
    } catch (error) {
      if (error instanceof ArtefactConflict) {
        const { title: currentTitle, markdown: currentMarkdown, version, updatedBy } = error.current;
        return { ok: true, saved: false, current: { title: currentTitle, markdown: currentMarkdown, version, updatedBy } };
      }
      throw error;
    }
  });
}
