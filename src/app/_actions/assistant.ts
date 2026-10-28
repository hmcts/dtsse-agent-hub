"use server";

import { revalidatePath } from "next/cache";
import { canStopAssistantAnswer } from "@/access/rules";
import { HttpError } from "@/agent-api/http";
import { confluenceExportRequest } from "@/assistant/confluence";
import { requestConfluenceExport } from "@/assistant/confluence-store";
import { attachForkContext, forkContextPending } from "@/assistant/fork-store";
import { requestJiraExport } from "@/assistant/jira-store";
import { saveAssistantModel as saveModel } from "@/assistant/model-store";
import { modelLabel } from "@/assistant/models";
import { CHAT_BLOCKED } from "@/assistant/onboarding";
import { MAX_ARTEFACT_MARKDOWN, MAX_ARTEFACT_TITLE } from "@/assistant/schemas";
import { sendToConversation } from "@/assistant/send";
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
  stopAnswer,
  writeArtefact
} from "@/assistant/store";
import { attachUploads, uploadNames } from "@/assistant/upload-store";
import { attachedBody, MAX_ATTACHMENTS_PER_MESSAGE } from "@/assistant/uploads";
import type { ThreadMessage } from "@/messages/direct-thread";
import { MAX_BODY } from "@/messages/limits";
import { prisma } from "@/store/prisma";
import { requireViewer } from "@/viewer/current";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { type ActionResult, runAction, text } from "@/web/action";
import { assistantChatGate } from "@/web/data";

/**
 * The HMCTS Assistant's writes, each for the signed-in person's own conversations only: `findConversation` reports
 * anyone else's as missing. A message is an ordinary direct message to the conversation's agent, through the same
 * `directAsPerson` as the hub's composer, followed by a wake when no session is running for it.
 */

// The Assistant runs on a virtual agent, so it is available exactly where they are.
const OFF: { ok: false; error: string } = { ok: false, error: "the HMCTS Assistant is not available on this deployment" };

const MISSING: { ok: false; error: string } = { ok: false, error: "that conversation no longer exists" };

/**
 * Refused while the person has yet to connect GitHub and Claude: `assistantChatGate` is the same gate the pages hold
 * the getting-ready screen on, so a page loaded before it closed, or a request made without the page, gets no further.
 */
const BLOCKED: { ok: false; error: string } = { ok: false, error: CHAT_BLOCKED };

/**
 * The message body, or the refusal. A message of files and no words is a message: handing the assistant a document is
 * a whole ask on its own, and the envelope names the files whether or not anything was typed. Only a message that is
 * empty of both is nothing to send.
 */
function checkBody(raw: unknown, attachments: number): string | { ok: false; error: string } {
  const body = typeof raw === "string" ? raw : "";
  if (body.trim() === "" && attachments === 0) {
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

async function send(oid: string, conversation: ConversationRow, typed: string, uploadIds: readonly string[] = []): Promise<ThreadMessage> {
  // Read before the insert, because a message of files and no words still needs a body: see `attachedBody`. The
  // claim inside the transaction below is what actually decides whether these files may be sent.
  const names = uploadIds.length === 0 ? [] : await uploadNames(prisma, oid, conversation.id, uploadIds);
  const wordless = typed.trim() === "";
  if (wordless && names.length === 0) {
    throw new HttpError(400, "one of those files is not ready to send; remove it and attach it again");
  }
  // The first message in a copy of someone else's chat also carries its earlier turns, as one more file, and a pod
  // reads no more than `MAX_ATTACHMENTS_PER_MESSAGE` off a message: past that the turns would be the file dropped.
  if (uploadIds.length >= MAX_ATTACHMENTS_PER_MESSAGE && (await forkContextPending(prisma, conversation.id))) {
    throw new HttpError(400, `the first message in a forked chat carries at most ${MAX_ATTACHMENTS_PER_MESSAGE - 1} files; remove one and send it again`);
  }
  const body = wordless ? attachedBody(names) : typed;
  return await sendToConversation(prisma, oid, conversation, {
    body,
    // A conversation opened by attaching a file and never typed in would otherwise be titled after the sentence
    // written for the person rather than after the only thing they actually chose, which is the file.
    title: wordless ? (names[0] ?? body) : typed,
    // Attached inside the message's own transaction: an id that is not this person's, is not this conversation's, is
    // not finished uploading, or is already on another message refuses the whole send, and no message is written.
    // The first message in a copy of someone else's chat also takes the copied turns, once.
    alongside: async (tx, messageId) => {
      await attachUploads(tx, { viewerOid: oid, conversationId: conversation.id, messageId, uploadIds });
      await attachForkContext(tx, { conversationId: conversation.id, ownerOid: oid, messageId });
    }
  });
}

/** A new conversation, started with its first message: a starter card's prompt, or what the person typed. */
export async function startConversation(input: { product: unknown; body: unknown }): Promise<ActionResult<{ id: string }>> {
  return await runAction<{ id: string }>("start conversation", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    if ((await assistantChatGate(viewer)) === "blocked") {
      return BLOCKED;
    }
    const body = checkBody(input.body, 0);
    if (typeof body !== "string") {
      return body;
    }
    const conversation = await createConversation(prisma, viewer.oid, { product: input.product });
    await send(viewer.oid, conversation, body);
    revalidatePath("/assistant");
    return { ok: true, id: conversation.id };
  });
}

/**
 * An empty conversation, for the new-chat screen to attach a file to.
 *
 * A file has to belong to a conversation before any of its bytes can be sent: the caps are per conversation, the row
 * lock the caps are read under is the conversation's, and `assistant_upload.conversation_id` is what the pod's
 * directory is named after. So attaching on the new-chat screen creates the conversation first, and the person's
 * first message then goes into it rather than starting another.
 *
 * It leaves an empty conversation behind if they attach and walk away. `sweepUploads` removes one whose only content
 * was an attachment nobody ever sent, a few hours later — see the note there for why it is swept rather than left.
 */
export async function openConversation(input: { product: unknown }): Promise<ActionResult<{ id: string }>> {
  return await runAction<{ id: string }>("open conversation", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    if ((await assistantChatGate(viewer)) === "blocked") {
      return BLOCKED;
    }
    const conversation = await createConversation(prisma, viewer.oid, { product: input.product });
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
    if ((await assistantChatGate(viewer)) === "blocked") {
      return BLOCKED;
    }
    const uploadIds = uploadIdsOf(input.uploadIds);
    const body = checkBody(input.body, uploadIds.length);
    if (typeof body !== "string") {
      return body;
    }
    const conversation = await findConversation(prisma, viewer.oid, text(input.conversationId));
    if (conversation === undefined) {
      return MISSING;
    }
    return { ok: true, message: await send(viewer.oid, conversation, body, uploadIds) };
  });
}

/** Asks for a session before the person has finished typing, so the first answer comes sooner. Says nothing back. */
export async function warmConversation(input: { conversationId: unknown }): Promise<ActionResult> {
  return await runAction("warm conversation", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    if ((await assistantChatGate(viewer)) === "blocked") {
      return BLOCKED;
    }
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

/**
 * Stops the answer the conversation is working on.
 *
 * `stopped` says whether a turn was actually ended, because the caller must not tell the person it was when it was
 * not. It is `false` only for the race: the UI offers the control while the session reads `busy`, and that is at most
 * a few seconds stale, so an answer can land between the press and the read. Nothing is recorded and nothing is
 * said — a separator under a completed answer would be a worse lie than silence.
 *
 * A session whose client is too old to act on an interrupt is a refusal rather than a quiet `false`, because waiting
 * will not make that one stoppable.
 */
export async function stopAssistantAnswer(input: { conversationId: unknown }): Promise<ActionResult<{ stopped: boolean }>> {
  return await runAction<{ stopped: boolean }>("stop assistant answer", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const conversation = await findConversation(prisma, viewer.oid, text(input.conversationId));
    if (conversation === undefined) {
      return MISSING;
    }
    // The owner-scoped read above is the enforcement: it reports anyone else's conversation as missing. This names
    // the rule, so that "only the owner may interrupt a turn" is written down and tested somewhere rather than
    // living in one query's WHERE clause, and so a future unscoped read seam has something to fail against.
    if (!canStopAssistantAnswer(viewer.oid, conversation)) {
      return MISSING;
    }
    const outcome = await stopAnswer(prisma, conversation);
    if (outcome === "unsupported-client") {
      return { ok: false, error: "this chat's assistant was started by an older version that cannot be stopped. It can be stopped once it next starts." };
    }
    return { ok: true, stopped: outcome === "stopped" };
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

/**
 * The Claude model all of the signed-in person's chats run on, from the settings dialog. The viewer is re-read and is
 * the only person a request can reach, as the sibling settings actions are. Revalidates `/assistant` as a layout,
 * because the dialog is rendered from the same tree on every page of it.
 *
 * Nothing is sent to the pod: a chat already running picks the change up from its next message's frame, which the pod
 * switches the session on before delivering, and a session started later is started on it from the wake.
 *
 * The confirmation says the choice is saved and nothing about when it takes effect, because that depends on the pod:
 * one on a client predating the family aliases drops this id and runs hai's default until it restarts. When it does,
 * the Model section is what says so — it reads the pod's `model-alias` claim, which the action does not.
 */
export async function saveAssistantModel(form: FormData): Promise<ActionResult<{ confirmation: string }>> {
  return await runAction<{ confirmation: string }>("save assistant model", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const model = await saveModel(prisma, viewer.oid, form.get("model"));
    revalidatePath("/assistant", "layout");
    return { ok: true, confirmation: `${modelLabel(model)} saved as the model for your chats` };
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

/**
 * Asks the person's assistant to create the conversation's saved document in the Jira backlog of `project`, as a Story
 * it makes with `twg` and their Atlassian sign-in. The request is an ordinary message in the chat, so the person sees
 * what was asked; how to carry it out goes to the session in the message's frame. The panel follows the export
 * through the conversation's events.
 */
export async function exportArtefactToJira(input: { conversationId: unknown; project: unknown }): Promise<ActionResult> {
  return await runAction("export artefact to jira", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const conversation = await findConversation(prisma, viewer.oid, text(input.conversationId));
    if (conversation === undefined) {
      return MISSING;
    }
    await requestJiraExport(prisma, conversation, input.project);
    await send(viewer.oid, conversation, `Please export this document to the ${String(input.project)} backlog in Jira.`);
    return { ok: true };
  });
}

/**
 * Asks the person's assistant to publish the conversation's saved document to Confluence, as a new page under
 * `parent`, which it creates with `twg` and their Atlassian sign-in. As with Jira, the request is an ordinary message
 * in the chat and how to carry it out goes to the session in the message's frame.
 */
export async function exportArtefactToConfluence(input: { conversationId: unknown; parent: unknown }): Promise<ActionResult> {
  return await runAction("export artefact to confluence", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const conversation = await findConversation(prisma, viewer.oid, text(input.conversationId));
    if (conversation === undefined) {
      return MISSING;
    }
    const parent = await requestConfluenceExport(prisma, conversation, input.parent);
    await send(viewer.oid, conversation, confluenceExportRequest(parent));
    return { ok: true };
  });
}
