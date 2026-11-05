import type { Database } from "../store/prisma.ts";
import { ARTEFACT_SELECT, toArtefact } from "./artefact-store.ts";
import { CONFLUENCE_SELECT, type ConfluenceExportFrame, pendingConfluenceExport } from "./confluence.ts";
import { DECK_SELECT, deckAuthor, newestAgentVersion } from "./deck-store.ts";
import { GITHUB_SELECT, type GithubExportFrame, pendingGithubExport } from "./github.ts";
import { JIRA_SELECT, type JiraExportFrame, pendingJiraExport } from "./jira.ts";
import { readAssistantModel } from "./model-store.ts";
import { productLabel } from "./products.ts";
import { type FrameAttachment, frameAttachments } from "./upload-store.ts";

/**
 * What a direct frame to a conversation's agent carries, or `undefined` for any other agent.
 *
 * No field is gated on a `client_features` claim (`src/agents/client-features.ts`): `attachments`, `jira_export`,
 * `github_export` and `confluence_export` go to every session. A client too old to read `attachments` drops that message's files
 * and nobody is told; one too old to read an export field is handed the request in words, and
 * the export fails on its 15-minute timeout.
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
  artefact_version: number;
  artefact_updated_by: "user" | "agent" | null;
  /** The conversation's slide deck's latest version, 0 before there is one, and who wrote it. */
  deck_version: number;
  deck_updated_by: "user" | "agent" | null;
  /** Moved on by every write of the outline, so an amend of the person's latest version is seen though `deck_version` stays. */
  deck_revision: number;
  /** The newest kept version the session wrote itself, 0 when none is: what the prompt's context tells it to diff from. */
  deck_agent_version: number;
  /** While an export to Jira is pending: what to create, which the session carries out with `twg`. */
  jira_export?: JiraExportFrame;
  /** While an export to GitHub is pending: the repository to create the issue in, which the session does with `gh`. */
  github_export?: GithubExportFrame;
  /** While an export to Confluence is pending: where to create the page, which the session carries out with `twg`. */
  confluence_export?: ConfluenceExportFrame;
  /**
   * The files the person attached to this message, for the pod to fetch to its disk before it delivers the message.
   * Absent from a frame built without a message — a wake rather than a delivery — and an empty array for a message
   * nothing was attached to. `readAttachments` in the published client is what the pod decides on: it answers the
   * entries it will fetch and an error outcome for each it refuses, so an entry this hub and that client disagree
   * about reaches the session as a file that could not be retrieved rather than as nothing.
   */
  attachments?: FrameAttachment[];
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
        select: { id: true, ownerOid: true, product: true, ...ARTEFACT_SELECT, ...DECK_SELECT, ...JIRA_SELECT, ...GITHUB_SELECT, ...CONFLUENCE_SELECT }
      }
    }
  });
  const conversation = row?.assistantConversation;
  if (conversation === null || conversation === undefined) {
    return undefined;
  }
  const artefact = toArtefact(conversation);
  const jira = pendingJiraExport(conversation);
  const github = pendingGithubExport(conversation);
  const confluence = pendingConfluenceExport(conversation);
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
    artefact_version: artefact.version,
    artefact_updated_by: artefact.updatedBy,
    deck_version: conversation.deckVersion,
    deck_updated_by: deckBy,
    deck_revision: conversation.deckRevision,
    deck_agent_version: agentVersion,
    ...(jira === undefined ? {} : { jira_export: jira }),
    ...(github === undefined ? {} : { github_export: github }),
    ...(confluence === undefined ? {} : { confluence_export: confluence }),
    ...(attachments === undefined ? {} : { attachments })
  };
}
