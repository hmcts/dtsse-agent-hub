import { storedClientFeatures } from "../agents/client-features.ts";
import { type Skill, storedSkills } from "../agents/skills.ts";
import type { CredentialKind } from "../credentials/names.ts";
import { agentQuestions, type QuestionView } from "../questions/views.ts";
import type { AgentStatus } from "../realtime/events.ts";
import type { Database } from "../store/prisma.ts";
import type { ConversationPage } from "../transcripts/conversation.ts";
import { agentConversation } from "../transcripts/views.ts";
import type { VirtualAgentDesired, VirtualAgentStatus } from "../virtual-agents/lifecycle.ts";
import { type LoginView, loginViews } from "../virtual-agents/logins.ts";
import type { VirtualAgentRow } from "../virtual-agents/store.ts";
import { neededCredentials, optionalCredentials } from "../virtual-agents/views.ts";
import type { ConfluenceExportView } from "./confluence.ts";
import { readConfluenceExport } from "./confluence-store.ts";
import { FORKED_SELECT, type ForkedView, forkedView } from "./forks.ts";
import { type DateGroup, groupByDate } from "./grouping.ts";
import type { JiraExportView } from "./jira.ts";
import { readJiraExport } from "./jira-store.ts";
import { chatCredentials, onboarded, type Readiness, readiness } from "./onboarding.ts";
import { productLabel } from "./products.ts";
import { snippetOf } from "./search.ts";
import { type Artefact, type ConversationRow, listConversations, readArtefact, type SessionState, searchConversations, unsentConversation } from "./store.ts";
import { type MessageAttachment, unsentAttachments } from "./upload-store.ts";

/** The HMCTS Assistant as its pages show it. Only ever the viewer's own: nobody sees anyone else's assistant. */

export interface AssistantSummary {
  id: string;
  name: string;
  desired: VirtualAgentDesired;
  status: VirtualAgentStatus;
  statusDetail: string | null;
  /** When it last changed what it is doing, so the waiting screen can say when one step is taking too long. */
  statusChangedAt: string;
  /** When it was last asked to run, which names one wait: a choice about watching it does not outlive it. */
  startedAt: string;
  readiness: Readiness;
  needed: CredentialKind[];
  optional: CredentialKind[];
  logins: LoginView[];
  /** Every needed credential is stored, so the connections are offered again only for a sign-in the pod asks for. */
  onboarded: boolean;
  /** The needed credentials without which the chat is not reachable at all; see `chatGate`. */
  toChat: CredentialKind[];
}

export interface ConversationLink {
  id: string;
  title: string;
  product: string;
  productLabel: string;
  lastActiveAt: string;
}

export const UNTITLED = "New chat";

export async function assistantSummary(db: Database, assistant: VirtualAgentRow, stored: ReadonlySet<CredentialKind>): Promise<AssistantSummary> {
  const needed = neededCredentials(assistant.modelRoute);
  return {
    id: assistant.id,
    name: assistant.name,
    desired: assistant.desired,
    status: assistant.status,
    statusDetail: assistant.statusDetail,
    statusChangedAt: assistant.statusChangedAt.toISOString(),
    startedAt: assistant.startedAt.toISOString(),
    readiness: readiness(assistant.status),
    needed,
    optional: optionalCredentials(assistant.modelRoute),
    logins: await loginViews(db, assistant.id),
    onboarded: onboarded(needed, stored),
    toChat: chatCredentials(needed, assistant.modelRoute)
  };
}

function toLink(row: Pick<ConversationRow, "id" | "title" | "product" | "lastActiveAt">): ConversationLink {
  return {
    id: row.id,
    title: row.title ?? UNTITLED,
    product: row.product,
    productLabel: productLabel(row.product),
    lastActiveAt: row.lastActiveAt.toISOString()
  };
}

/** The chats running on one of the owner's virtual agents, for its page in the hub. */
export async function conversationLinks(db: Database, ownerOid: string, virtualAgentId: string): Promise<ConversationLink[]> {
  return (await listConversations(db, ownerOid, 200, virtualAgentId)).map(toLink);
}

export async function conversationGroups(db: Database, ownerOid: string, now: Date = new Date()): Promise<{ label: DateGroup; items: ConversationLink[] }[]> {
  const rows = await listConversations(db, ownerOid);
  return groupByDate(rows.map(toLink), (link) => new Date(link.lastActiveAt), now);
}

export interface ConversationMatch extends ConversationLink {
  /** Why the chat matched, when its title does not already show it: the words around the match in one message. */
  snippet: string | null;
}

/** The viewer's own chats matching every word of `query`, for the sidebar's search. */
export async function conversationMatches(db: Database, ownerOid: string, query: string): Promise<ConversationMatch[]> {
  const rows = await searchConversations(db, ownerOid, query);
  return rows.map((row) => ({ ...toLink(row), snippet: snippetOf(row.excerpt) }));
}

/**
 * The conversation the new-chat screen already opened for a file and nobody sent, as that screen needs it back.
 *
 * Read from the hub rather than kept in the browser, because the hub is where the state actually is: the bytes are in
 * Postgres against this conversation and the product is on its row. Keeping a copy client-side would be a second
 * answer to the same question, and the one that goes stale.
 */
export interface UnsentChat {
  id: string;
  product: string;
  attachments: MessageAttachment[];
}

/**
 * The viewer's unsent new chat, if they have one. There is at most one that matters: the newest, since the screen can
 * only be composing in one of them, and any older one is the sweep's to take.
 *
 * `undefined` once a message has been sent in it, which is the same moment the new chat's draft is discarded — so the
 * text and the files it belongs with always come back together, or not at all.
 */
export async function unsentChat(db: Database, ownerOid: string): Promise<UnsentChat | undefined> {
  const conversation = await unsentConversation(db, ownerOid);
  if (conversation === undefined) {
    return undefined;
  }
  return {
    id: conversation.id,
    product: conversation.product,
    attachments: await unsentAttachments(db, conversation.id)
  };
}

export interface ConversationView {
  id: string;
  title: string;
  product: string;
  productLabel: string;
  productHistory: { product: string; at: string }[];
  /** Every answer the person stopped, so the thread shows where each one was cut off. */
  stopHistory: { at: string }[];
  agentId: string;
  agentStatus: AgentStatus;
  /**
   * What the composer's "/" autocomplete offers: the skills the conversation's session reported. Empty until one has
   * registered, so a chat whose assistant is not running yet gets no list. No access check guards it, unlike the
   * hub's agent page: a conversation is only ever read by its owner, who is the only person who can message it.
   */
  skills: Skill[];
  /**
   * What the client running this conversation's session claimed it understands. `null` from a client that reported
   * nothing, which claims nothing; ask with `clientSupports` rather than reading the list, so old and current clients
   * answer the same way. A pod runs whatever client version it booted with, so this is per conversation, not per
   * deployment.
   *
   * Carried to the screen so the composer can offer — or refuse, and say why — anything the session could not act on.
   * `ChatView` reads it for `stop`, and offers no stop control on a session whose client would ignore the interrupt.
   */
  clientFeatures: string[] | null;
  sessionState: SessionState | null;
  sessionDetail: string | null;
  artefact: { title: string | null; markdown: string; version: number; updatedBy: Artefact["updatedBy"]; updatedAt: string | null };
  jira: JiraExportView;
  confluence: ConfluenceExportView;
  page: ConversationPage;
  /** Where the chat was forked from and the words copied from it, shown above its own; `null` unless it is a copy. */
  forked: ForkedView | null;
  /**
   * The questions this conversation's session asked, which the thread shows as cards. Read beside the page rather
   * than inside it: a question is a row of its own, not a transcript entry, and the transcript route that serves
   * later pages does not carry them.
   */
  questions: QuestionView[];
}

/** One of the viewer's conversations with its first page; `agentId` is the conversation's current agent. */
export async function conversationView(db: Database, conversation: ConversationRow, agentId: string): Promise<ConversationView> {
  // The conversation's own agent, which is its owner's alone: both reads below apply their own rule to it, and no
  // grant is passed because none extends to a conversation.
  const agent = { id: agentId, ownerOid: conversation.ownerOid, ownerOnly: true };
  const [current, artefact, jira, confluence, page, questions, fork] = await Promise.all([
    db.agent.findUnique({ where: { id: agentId }, select: { status: true, skills: true, clientFeatures: true } }),
    readArtefact(db, conversation.id),
    readJiraExport(db, conversation.id),
    readConfluenceExport(db, conversation.id),
    agentConversation(db, conversation.ownerOid, agent, []),
    agentQuestions(db, conversation.ownerOid, agent, []),
    db.assistantConversation.findUnique({ where: { id: conversation.id }, select: FORKED_SELECT })
  ]);
  return {
    id: conversation.id,
    title: conversation.title ?? UNTITLED,
    product: conversation.product,
    productLabel: productLabel(conversation.product),
    productHistory: conversation.productHistory,
    stopHistory: conversation.stopHistory,
    agentId,
    agentStatus: current?.status ?? "offline",
    skills: storedSkills(current?.skills),
    clientFeatures: storedClientFeatures(current?.clientFeatures),
    sessionState: conversation.sessionState,
    sessionDetail: conversation.sessionDetail,
    artefact: { ...artefact, updatedAt: artefact.updatedAt?.toISOString() ?? null },
    jira,
    confluence,
    page,
    forked: fork === null ? null : forkedView(fork),
    questions
  };
}
