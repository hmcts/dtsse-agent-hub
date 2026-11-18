import type { Database } from "../store/prisma.ts";
import { DOCUMENT_SELECT, OLDEST_FIRST, toDocument } from "./artefact-store.ts";
import { CONFLUENCE_SELECT, type ConfluenceExportFrame, pendingConfluenceExport } from "./confluence.ts";
import { DECK_SELECT, deckAuthor, newestAgentVersion } from "./deck-store.ts";
import { DOCMOSIS_SELECT, docmosisAuthor } from "./docmosis-store.ts";
import { type DocumentKind, primaryDocument } from "./documents.ts";
import { GITHUB_SELECT, type GithubExportFrame, pendingGithubExport } from "./github.ts";
import { JIRA_SELECT, type JiraExportFrame, pendingJiraExport } from "./jira.ts";
import { readAssistantModel } from "./model-store.ts";
import { NOTIFY_SELECT, notifyAuthor } from "./notify-store.ts";
import { productLabel } from "./products.ts";
import { type FrameAttachment, frameAttachments } from "./upload-store.ts";

/**
 * What a direct frame to a conversation's agent carries, or `undefined` for any other agent.
 *
 * No field is gated on a `client_features` claim (`src/agents/client-features.ts`): `attachments`, `jira_export`,
 * `github_export` and `confluence_export` go to every session. A client too old to read `attachments` drops that message's files
 * and nobody is told; one too old to read an export field is handed the request in words, and
 * the export fails on its 15-minute timeout. One older than `items` ignores `artefacts` and an export's `document_id`
 * and reads only the primary document, which is why the hub holds a conversation on such a pod to that one
 * (`ITEMS_CREATE_REFUSED`, `ITEMS_EXPORT_REFUSED`).
 */
export interface AssistantFrame {
  conversation_id: string;
  product: string;
  product_label: string;
  /**
   * The model the conversation's owner chose for all of their chats. The pod switches the session to it before
   * delivering the message when the session is on another, which is what makes a change in the settings apply from
   * the next message rather than from the next session.
   */
  model: string;
  /** The primary document's version, 0 before there is one, and who wrote it: what a client older than `artefacts` reads. */
  artefact_version: number;
  artefact_updated_by: "user" | "agent" | null;
  /** Every document, oldest first, without its markdown, which the session reads with `artefact get --id`. */
  artefacts: FrameDocument[];
  /** The conversation's slide deck's latest version, 0 before there is one, and who wrote it. */
  deck_version: number;
  deck_updated_by: "user" | "agent" | null;
  /** Moved on by every write of the outline, so an amend of the person's latest version is seen though `deck_version` stays. */
  deck_revision: number;
  /** The newest kept version the session wrote itself, 0 when none is: what the prompt's context tells it to diff from. */
  deck_agent_version: number;
  /** The conversation's Docmosis template's latest version, 0 before there is one, its revision, and who wrote it. */
  docmosis_version: number;
  docmosis_revision: number;
  docmosis_updated_by: "user" | "agent" | null;
  /** The conversation's GOV.UK Notify template's latest version, 0 before there is one, its revision, and who wrote it. */
  notify_version: number;
  notify_revision: number;
  notify_updated_by: "user" | "agent" | null;
  /** While an export to Jira is pending: what to create, which the session carries out with `twg`. */
  jira_export?: JiraExportFrame & DocumentRef;
  /** While an export to GitHub is pending: the repository to create the issue in, which the session does with `gh`. */
  github_export?: GithubExportFrame & DocumentRef;
  /** While an export to Confluence is pending: where to create the page, which the session carries out with `twg`. */
  confluence_export?: ConfluenceExportFrame & DocumentRef;
  /**
   * The files the person attached to this message, for the pod to fetch to its disk before it delivers the message.
   * Absent from a frame built without a message — a wake rather than a delivery — and an empty array for a message
   * nothing was attached to. `readAttachments` in the published client is what the pod decides on: it answers the
   * entries it will fetch and an error outcome for each it refuses, so an entry this hub and that client disagree
   * about reaches the session as a file that could not be retrieved rather than as nothing.
   */
  attachments?: FrameAttachment[];
}

export interface FrameDocument {
  id: string;
  kind: DocumentKind;
  title: string | null;
  version: number;
  updated_by: "user" | "agent" | null;
}

/** Which document an export is of, which the session's export command reads by id. */
interface DocumentRef {
  document_id: string;
}

/**
 * The pending export of a tool that the message being framed asks for. Each export is asked for in a message of its own,
 * sent right after the request is recorded, so it is the one requested nearest the message's creation: with exports
 * for two documents queued, each message carries its own. Without a message (a wake), or for one sent after them
 * all, that is the most recently requested.
 */
function nearestPending<D extends { id: string }, F>(
  documents: readonly D[],
  pending: (document: D) => F | undefined,
  requestedAt: (document: D) => Date | null,
  messageAt: Date | undefined
): (F & DocumentRef) | undefined {
  const target = messageAt?.getTime() ?? Number.POSITIVE_INFINITY;
  let best: { distance: number; at: number; frame: F & DocumentRef } | undefined;
  for (const document of documents) {
    const frame = pending(document);
    const at = requestedAt(document)?.getTime() ?? 0;
    const distance = Math.abs(target - at);
    if (frame !== undefined && (best === undefined || distance < best.distance || (distance === best.distance && at > best.at))) {
      best = { distance, at, frame: { ...frame, document_id: document.id } };
    }
  }
  return best?.frame;
}

/**
 * The newest kept version the session wrote, read from the versions only when the person wrote the latest: when the
 * session did, it is the latest, and with no version or no author there is none. Every message is framed, so this
 * keeps the common case to no query.
 */
function agentVersionOf(db: Database, conversationId: string, version: number, by: "user" | "agent" | null): Promise<number> | number {
  if (version > 0 && by === "user") {
    return newestAgentVersion(db, conversationId);
  }
  return version > 0 && by === "agent" ? version : 0;
}

/** `messageId` is the direct being framed, which is what the attachments hang off. */
export async function assistantFrame(db: Database, agentId: string, messageId?: bigint): Promise<AssistantFrame | undefined> {
  const row = await db.agent.findUnique({
    where: { id: agentId },
    select: {
      assistantConversation: {
        select: {
          id: true,
          ownerOid: true,
          product: true,
          ...DECK_SELECT,
          ...DOCMOSIS_SELECT,
          ...NOTIFY_SELECT,
          documents: { select: { ...DOCUMENT_SELECT, ...JIRA_SELECT, ...GITHUB_SELECT, ...CONFLUENCE_SELECT }, orderBy: [...OLDEST_FIRST] }
        }
      }
    }
  });
  const conversation = row?.assistantConversation;
  if (conversation === null || conversation === undefined) {
    return undefined;
  }
  const messageAt = messageId === undefined ? undefined : (await db.message.findUnique({ where: { id: messageId }, select: { createdAt: true } }))?.createdAt;
  const rows = conversation.documents;
  const documents = rows.map(toDocument);
  const primary = primaryDocument(documents);
  const jira = nearestPending(
    rows,
    (row) => pendingJiraExport(row),
    (row) => row.jiraRequestedAt,
    messageAt
  );
  const github = nearestPending(
    rows,
    (row) => pendingGithubExport(row),
    (row) => row.githubRequestedAt,
    messageAt
  );
  const confluence = nearestPending(
    rows,
    (row) => pendingConfluenceExport(row),
    (row) => row.confluenceRequestedAt,
    messageAt
  );
  const deckBy = deckAuthor(conversation);
  const [model, agentVersion, attachments] = await Promise.all([
    readAssistantModel(db, conversation.ownerOid),
    agentVersionOf(db, conversation.id, conversation.deckVersion, deckBy),
    messageId === undefined ? undefined : frameAttachments(db, messageId)
  ]);
  return {
    conversation_id: conversation.id,
    // What the conversation is stored as, not what the picker can show: this is the subject the session has been
    // working in, and a product dropped from the list still names it. `productLabel` falls back to the slug.
    product: conversation.product,
    product_label: productLabel(conversation.product),
    model,
    artefact_version: primary?.version ?? 0,
    artefact_updated_by: primary?.updatedBy ?? null,
    artefacts: documents.map((document) => ({
      id: document.id,
      kind: document.kind,
      title: document.title,
      version: document.version,
      updated_by: document.updatedBy
    })),
    deck_version: conversation.deckVersion,
    deck_updated_by: deckBy,
    deck_revision: conversation.deckRevision,
    deck_agent_version: agentVersion,
    docmosis_version: conversation.docmosisVersion,
    docmosis_revision: conversation.docmosisRevision,
    docmosis_updated_by: docmosisAuthor(conversation),
    notify_version: conversation.notifyVersion,
    notify_revision: conversation.notifyRevision,
    notify_updated_by: notifyAuthor(conversation),
    ...(jira === undefined ? {} : { jira_export: jira }),
    ...(github === undefined ? {} : { github_export: github }),
    ...(confluence === undefined ? {} : { confluence_export: confluence }),
    ...(attachments === undefined ? {} : { attachments })
  };
}
