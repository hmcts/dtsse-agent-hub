"use server";

import { revalidatePath } from "next/cache";
import { HttpError } from "@/agent-api/http";
import { type Artefact, ArtefactConflict, removeDocument, UUID_RE, writeDocument } from "@/assistant/artefact-store";
import { confluenceExportRequest } from "@/assistant/confluence";
import { requestConfluenceExport } from "@/assistant/confluence-store";
import type { ConversationRow } from "@/assistant/conversation-row";
import {
  conversationAgent,
  createConversation,
  findConversation,
  pinConversation as pin,
  deleteConversation as remove,
  renameConversation as rename,
  setProduct
} from "@/assistant/conversation-store";
import { removeDocmosisTemplate as removeDocmosis } from "@/assistant/docmosis-store";
import { type DocumentKind, isDocumentKind } from "@/assistant/documents";
import { attachForkContext, forkContextPending } from "@/assistant/fork-store";
import { readGithubProject } from "@/assistant/github";
import { requestGithubExport } from "@/assistant/github-store";
import { requestJiraExport } from "@/assistant/jira-store";
import { saveAssistantModel as saveModel } from "@/assistant/model-store";
import { modelLabel } from "@/assistant/models";
import { removeNotify } from "@/assistant/notify-store";
import { CHAT_BLOCKED } from "@/assistant/onboarding";
import { hasPod } from "@/assistant/pods";
import { MAX_ARTEFACT_MARKDOWN, MAX_ARTEFACT_TITLE } from "@/assistant/schemas";
import { sendToConversation } from "@/assistant/send";
import { requestWake, stopAnswer } from "@/assistant/session-store";
import { attachUploads, storeUploadBytes, uploadNames } from "@/assistant/upload-store";
import { attachedBody, MAX_ATTACHMENTS_PER_MESSAGE } from "@/assistant/uploads";
import { needsWake } from "@/assistant/wake";
import { clip, DEFAULT_JAVA_PACKAGE, handoffPrompt, isHandoffTarget, isSignedOff, JAVA_TARGETS, NOT_SIGNED_OFF } from "@/bulk-scan/handoff";
import { handoffFiles } from "@/bulk-scan/handoff-files";
import { loadSpec } from "@/bulk-scan/load";
import { type Download, versionOf } from "@/bulk-scan/spec";
import type { ThreadMessage } from "@/messages/direct-thread";
import { MAX_BODY } from "@/messages/limits";
import { prisma } from "@/store/prisma";
import { requireViewer } from "@/viewer/current";
import type { Viewer } from "@/viewer/identity";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { type ActionResult, runAction, text } from "@/web/action";
import { assistantChatGate } from "@/web/data";

/**
 * The CFT Workspace's writes, each for the signed-in person's own conversations only: `findConversation` reports
 * anyone else's as missing. A message is an ordinary direct message to the conversation's agent, through the same
 * `directAsPerson` as the hub's composer, followed by a wake when no session is running for it.
 */

// The Assistant runs on a virtual agent, so it is available exactly where they are.
const OFF: { ok: false; error: string } = { ok: false, error: "the CFT Workspace is not available on this deployment" };

const MISSING: { ok: false; error: string } = { ok: false, error: "that conversation no longer exists" };

/**
 * Refused while the person has yet to connect GitHub and Claude: `assistantChatGate` is the same gate the pages hold
 * the getting-ready screen on, so a page loaded before it closed, or a request made without the page, gets no further.
 */
const BLOCKED: { ok: false; error: string } = { ok: false, error: CHAT_BLOCKED };

/**
 * Whether the gate holds this conversation shut.
 *
 * Only where a pod is involved. `assistantChatGate` tests the credentials a *pod* needs — GitHub, and the credential
 * its session reaches a model with — because without them there is no session for a message to be answered by. A
 * conversation with no pod is a Claude Code session already running on the person's own computer, on their own
 * credentials; the hub only has to carry the message to it, which needs nothing of theirs stored here. Asked of one
 * of those, the gate would leave somebody who has never set up an Assistant able to read their laptop chats and
 * unable to answer one, with a refusal naming accounts that have nothing to do with the session they are typing to.
 *
 * Read after the conversation, so the gate is only read where it can apply at all.
 */
async function gated(viewer: Viewer, conversation: ConversationRow): Promise<boolean> {
  return hasPod(conversation) && (await assistantChatGate(viewer)) === "blocked";
}

/**
 * An export: what every tool shares. The chat's gate, as for a message; then `request`, which writes the export
 * pending and answers the message that asks for it; then the message. A send that fails leaves the export pending
 * until its window passes, when it can be asked for again.
 */
async function exportDocument(
  input: { conversationId: unknown; documentId: unknown },
  request: (conversation: ConversationRow, document: string) => Promise<string>
): Promise<ActionResult> {
  if (!virtualAgentsEnabled()) {
    return OFF;
  }
  const viewer = await requireViewer();
  const conversation = await findConversation(prisma, viewer.oid, text(input.conversationId));
  if (conversation === undefined) {
    return MISSING;
  }
  if (await gated(viewer, conversation)) {
    return BLOCKED;
  }
  await send(viewer.oid, conversation, await request(conversation, await named(conversation.id, input.documentId)));
  return { ok: true };
}

/**
 * The message body, or the refusal. A message of files and no words is a message: handing the assistant a document is
 * a whole ask on its own, and the prompt's context names the files whether or not anything was typed. Only a message that is
 * empty of both is nothing to send.
 */
function checkBody(raw: unknown, attachments: number): string | { ok: false; error: string } {
  const body = typeof raw === "string" ? raw : "";
  if (body.trim() === "" && attachments === 0) {
    return { ok: false, error: "write something to send" };
  }
  if (body.length > MAX_BODY) {
    return { ok: false, error: `Your message is too long. Keep it to ${MAX_BODY.toLocaleString("en-GB")} characters or fewer.` };
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

/** `generated` are files the hub made, stored on the message in its transaction rather than claimed from the composer. */
async function send(
  oid: string,
  conversation: ConversationRow,
  typed: string,
  uploadIds: readonly string[] = [],
  generated: readonly Download[] = []
): Promise<ThreadMessage> {
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
      for (const file of generated) {
        await storeUploadBytes(tx, {
          conversationId: conversation.id,
          ownerOid: oid,
          messageId,
          fileName: file.fileName,
          mediaType: file.contentType,
          bytes: file.bytes
        });
      }
      await attachUploads(tx, { viewerOid: oid, conversationId: conversation.id, messageId, uploadIds });
      await attachForkContext(tx, { conversationId: conversation.id, ownerOid: oid, messageId });
    }
  });
}

/**
 * A new conversation, started with its first message: a starter card's prompt, what the person typed, or a workflow's
 * prompt such as the morning briefing's. `title` names it where the first message would make a poor name, as a
 * skill's invocation does; left out, the first message names it.
 */
export async function startConversation(input: { product: unknown; body: unknown; title?: unknown }): Promise<ActionResult<{ id: string }>> {
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
    const conversation = await createConversation(prisma, viewer.oid, { product: input.product, title: text(input.title) });
    await send(viewer.oid, conversation, body);
    revalidatePath("/assistant");
    return { ok: true, id: conversation.id };
  });
}

/**
 * Removes the conversation a hand-over made when its send failed, and answers whether it did. Not when the message
 * committed: the files are stored in the message's transaction, so any upload says it did. A cleanup that fails is
 * logged and the conversation counts as kept.
 */
async function removeUnsent(oid: string, conversationId: string): Promise<boolean> {
  try {
    if ((await prisma.assistantUpload.count({ where: { conversationId } })) > 0) {
      return false;
    }
    await remove(prisma, oid, conversationId);
    return true;
  } catch (cleanup) {
    console.error(`the hand-over's conversation could not be removed: ${cleanup instanceof Error ? (cleanup.stack ?? cleanup.message) : String(cleanup)}`);
    return true;
  }
}

/**
 * Hands a signed-off Bulk Scan form to the Assistant: a new conversation whose first message asks for the service's pull
 * request and carries the form's generated code, spec and transformation sheet. Only the owner's own signed-off version
 * goes: `loadSpec` reports anyone else's form as missing, and a version that is saved but not signed off is refused.
 * The files are stored in the message's own transaction, so a refused send leaves neither a message nor a file. A
 * conversation whose send failed before its message committed is removed and the error reported; one whose message
 * committed is kept and opened, because the hand-over exists and only its start was interrupted. The conversation is made
 * and the message sent in separate transactions, so those two are not one step.
 */
export async function handToAssistant(form: FormData): Promise<ActionResult<{ id: string }>> {
  return await runAction<{ id: string }>("hand to assistant", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    if ((await assistantChatGate(viewer)) === "blocked") {
      return BLOCKED;
    }
    const target = text(form.get("target"));
    if (!isHandoffTarget(target)) {
      return { ok: false, error: "choose the code pattern the service uses" };
    }
    const version = versionOf(text(form.get("version")));
    if (version === undefined) {
      return { ok: false, error: "choose a version to hand over" };
    }
    const { record, spec } = await loadSpec(prisma, { actorOid: viewer.oid, ownerOid: viewer.oid }, text(form.get("id")), version);
    if (!isSignedOff(record.versions, version)) {
      return { ok: false, error: NOT_SIGNED_OFF };
    }
    // A Java target's package is as the person typed it, and a blank or invalid one is refused as the download route refuses it.
    const javaPackage = JAVA_TARGETS.includes(target) ? text(form.get("package")) : DEFAULT_JAVA_PACKAGE;
    const { files, names, newFields } = await handoffFiles(spec, target, javaPackage);
    const prompt = checkBody(handoffPrompt({ spec, version, target, javaPackage, names, newFields }), files.length);
    if (typeof prompt !== "string") {
      return prompt;
    }
    const conversation = await createConversation(prisma, viewer.oid, {
      product: "bulk-scan",
      title: `Hand over ${clip(spec.form.name) || clip(spec.form.formType)}`
    });
    try {
      await send(viewer.oid, conversation, prompt, [], files);
    } catch (error) {
      if (!(await removeUnsent(viewer.oid, conversation.id))) {
        // The message committed, so the hand-over exists and is only waiting to start: open it rather than leave the person to hand it over again.
        console.error(
          `the hand-over's conversation ${conversation.id} was kept after its send failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
        );
      } else {
        throw error;
      }
    }
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
    const conversation = await findConversation(prisma, viewer.oid, text(input.conversationId));
    if (conversation === undefined) {
      return MISSING;
    }
    if (await gated(viewer, conversation)) {
      return BLOCKED;
    }
    const uploadIds = uploadIdsOf(input.uploadIds);
    const body = checkBody(input.body, uploadIds.length);
    if (typeof body !== "string") {
      return body;
    }
    return { ok: true, message: await send(viewer.oid, conversation, body, uploadIds) };
  });
}

/**
 * Asks for a session before the person has finished typing, so the first answer comes sooner. Says nothing back.
 *
 * Nothing to ask for on a conversation with no pod, where `requestWake` is a no-op: the session is on a laptop and
 * comes back when it comes back. The composer does not call this for one, and this answers `ok` rather than a
 * refusal if anything else does, because a warm has never been something the person asked for.
 */
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
    if (await gated(viewer, conversation)) {
      return BLOCKED;
    }
    const agentId = await conversationAgent(prisma, conversation);
    const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { status: true } });
    // Asked even with a wake pending: `requestWake` keeps the first one's time and brings back a stopped or failed pod.
    if (needsWake(agent?.status, conversation.sessionState)) {
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
    // Only the owner interrupts a turn: `findConversation` reports anyone else's conversation as missing.
    const conversation = await findConversation(prisma, viewer.oid, text(input.conversationId));
    if (conversation === undefined) {
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
 * the model setting is what says so — it reads the pod's `model-alias` claim, which the action does not.
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

export async function pinConversation(input: { conversationId: unknown; pinned: unknown }): Promise<ActionResult> {
  return await runAction("pin conversation", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    await pin(prisma, viewer.oid, text(input.conversationId), input.pinned);
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

/** How the request in the chat names the document, once the export has found it: by its title, in quotes. */
async function named(conversationId: string, documentId: unknown): Promise<string> {
  // Read before the export is requested, so an id that is not one names nothing here and is refused by the request.
  if (typeof documentId !== "string" || !UUID_RE.test(documentId)) {
    return "this document";
  }
  const row = await prisma.assistantDocument.findFirst({ where: { id: documentId, conversationId }, select: { title: true } });
  return row?.title ? `the document "${row.title}"` : "this document";
}

export interface ArtefactSnapshot {
  title: string | null;
  markdown: string;
  version: number;
  updatedBy: Artefact["updatedBy"];
}

export type SaveArtefactResult = { saved: true; version: number } | { saved: false; current: ArtefactSnapshot };

const NO_DOCUMENT: { ok: false; error: string } = { ok: false, error: "that document no longer exists" };
const NO_NOTIFY_TEMPLATE: { ok: false; error: string } = { ok: false, error: "that Notify template no longer exists" };

/**
 * The person's edit of one of the conversation's documents, if nobody has changed it since `baseVersion`. Otherwise
 * nothing is saved and the current document comes back, for the panel to offer it or to overwrite it. A document the
 * panel opened new has an id the browser made, and its first save, at base 0, creates it as `kind`, a plain document
 * unless it says otherwise.
 */
export async function saveArtefact(input: {
  conversationId: unknown;
  documentId: unknown;
  kind?: unknown;
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
      return { ok: false, error: `The document is too long. Keep it to ${MAX_ARTEFACT_MARKDOWN.toLocaleString("en-GB")} characters or fewer.` };
    }
    const title = text(input.title).slice(0, MAX_ARTEFACT_TITLE) || null;
    const baseVersion = typeof input.baseVersion === "number" && Number.isInteger(input.baseVersion) && input.baseVersion >= 0 ? input.baseVersion : 0;
    const documentId = text(input.documentId);
    if (!UUID_RE.test(documentId)) {
      return NO_DOCUMENT;
    }
    const create: DocumentKind = isDocumentKind(input.kind) ? input.kind : "document";
    const conversation = await findConversation(prisma, viewer.oid, text(input.conversationId));
    if (conversation === undefined) {
      return MISSING;
    }
    try {
      const version = await writeDocument(prisma, conversation, documentId, { title, markdown, baseVersion, by: "user", create });
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

/** Removes one of the conversation's documents. A ticket or page already made from it stays where it was made. */
export async function removeArtefact(input: { conversationId: unknown; documentId: unknown }): Promise<ActionResult> {
  return await runAction("remove artefact", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const conversation = await findConversation(prisma, viewer.oid, text(input.conversationId));
    if (conversation === undefined) {
      return MISSING;
    }
    const documentId = text(input.documentId);
    if (!UUID_RE.test(documentId)) {
      return NO_DOCUMENT;
    }
    await removeDocument(prisma, conversation, documentId);
    return { ok: true };
  });
}

/** Removes one of the conversation's Notify templates, with its versions. */
export async function removeNotifyTemplate(input: { conversationId: unknown; itemId: unknown }): Promise<ActionResult> {
  return await runAction("remove notify template", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const conversation = await findConversation(prisma, viewer.oid, text(input.conversationId));
    if (conversation === undefined) {
      return MISSING;
    }
    const itemId = text(input.itemId);
    if (!UUID_RE.test(itemId)) {
      return NO_NOTIFY_TEMPLATE;
    }
    await removeNotify(prisma, conversation, itemId);
    return { ok: true };
  });
}

/** Removes one of the conversation's Docmosis templates, with its versions. */
export async function removeDocmosisTemplate(input: { conversationId: unknown; itemId: unknown }): Promise<ActionResult> {
  return await runAction("remove docmosis template", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const conversation = await findConversation(prisma, viewer.oid, text(input.conversationId));
    if (conversation === undefined) {
      return MISSING;
    }
    const itemId = text(input.itemId);
    if (!UUID_RE.test(itemId)) {
      return { ok: false, error: "that template no longer exists" };
    }
    await removeDocmosis(prisma, conversation, itemId);
    return { ok: true };
  });
}

/**
 * Asks the person's assistant to create one of the conversation's saved documents in the Jira backlog of `project`, as a Story
 * it makes with `twg` and their Atlassian sign-in. The request is an ordinary message in the chat, so the person sees
 * what was asked; how to carry it out goes to the session in the message's frame. The panel follows the export
 * through the conversation's events.
 */
export async function exportArtefactToJira(input: { conversationId: unknown; documentId: unknown; project: unknown }): Promise<ActionResult> {
  return await runAction("export artefact to jira", () =>
    exportDocument(input, async (conversation, document) => {
      await requestJiraExport(prisma, conversation, input.documentId, input.project);
      return `Please export ${document} to the ${String(input.project)} backlog in Jira.`;
    })
  );
}

/**
 * Asks the person's assistant to create one of the conversation's saved documents as an issue in the GitHub repository
 * `repo`, which it makes with `gh` and their own GitHub token, and adds to `project` when the person chose one. As with Jira, the request is an ordinary message in the
 * chat and how to carry it out goes to the session in the message's frame.
 */
export async function exportArtefactToGithub(input: { conversationId: unknown; documentId: unknown; repo: unknown; project?: unknown }): Promise<ActionResult> {
  return await runAction("export artefact to github", () =>
    exportDocument(input, async (conversation, document) => {
      const repo = await requestGithubExport(prisma, conversation, input.documentId, input.repo, input.project ?? null);
      const project = readGithubProject(input.project ?? null);
      const board = project ? `, on the "${project.title}" Project` : "";
      return `Please create a GitHub issue for ${document} in ${repo}${board}.`;
    })
  );
}

/**
 * Asks the person's assistant to publish one of the conversation's saved documents to Confluence, as a new page under
 * `parent`, which it creates with `twg` and their Atlassian sign-in. As with Jira, the request is an ordinary message
 * in the chat and how to carry it out goes to the session in the message's frame.
 */
export async function exportArtefactToConfluence(input: { conversationId: unknown; documentId: unknown; parent: unknown }): Promise<ActionResult> {
  return await runAction("export artefact to confluence", () =>
    exportDocument(input, async (conversation, document) =>
      confluenceExportRequest(await requestConfluenceExport(prisma, conversation, input.documentId, input.parent), document)
    )
  );
}
