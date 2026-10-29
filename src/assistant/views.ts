import { storedClientFeatures } from "../agents/client-features.ts";
import { type Skill, storedSkills } from "../agents/skills.ts";
import type { CredentialKind } from "../credentials/names.ts";
import { agentQuestions, type QuestionView } from "../questions/views.ts";
import type { AgentStatus } from "../realtime/events.ts";
import type { Database } from "../store/prisma.ts";
import type { ConversationPage } from "../transcripts/conversation.ts";
import { agentConversation } from "../transcripts/views.ts";
import type { ModelRoute } from "../viewer/identity.ts";
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
import { hasPod } from "./pods.ts";
import { productLabel } from "./products.ts";
import { snippetOf } from "./search.ts";
import {
  type Artefact,
  type ConversationListRow,
  type ConversationRow,
  hasLocalConversation,
  listConversations,
  readArtefact,
  type SessionState,
  searchConversations,
  unsentConversation
} from "./store.ts";
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
  /** How its pod reaches Claude, which is fixed on its row and so is not always the person's own route. */
  modelRoute: ModelRoute;
  needed: CredentialKind[];
  optional: CredentialKind[];
  logins: LoginView[];
  /** Every needed credential is stored, so the connections are offered again only for a sign-in the pod asks for. */
  onboarded: boolean;
  /** The needed credentials without which the chat is not reachable at all; see `chatGate`. */
  toChat: CredentialKind[];
}

/**
 * Which of three states the session of a chat on the person's own computer is in: answering, connected and waiting,
 * or not connected at all. The agent's status in the words the mark says it in, so the colour, the tooltip and the
 * row's name are three renderings of one value rather than three mappings that can drift apart.
 */
export type LocalSession = "ready" | "working" | "disconnected";

/**
 * The three states the laptop mark shows, named for what they mean to a person reading the list.
 *
 * Coloured as `StatusDot` colours the same three statuses on the hub — `idle` green, `busy` amber, `offline` grey —
 * so one session does not read as green in one place and amber in another. That makes `idle` the welcoming state:
 * `offline` is a heartbeat gone for 90 seconds and so the only one that is really "not connected", while `idle` is a
 * live session with nothing in hand, which is when it will answer you fastest. `busy` is mid-turn, which is worth a
 * different colour precisely because a message sent then waits.
 */
const LOCAL_SESSION: Record<AgentStatus, LocalSession> = { idle: "ready", busy: "working", offline: "disconnected" };

/**
 * What a chat's row in the sidebar, and its result in the search, is marked with.
 *
 * Decided here rather than in either list, so a chat found by searching is marked exactly as the same chat in the
 * list below it. Three cases and no more:
 *
 * - `computer` — a Claude Code session on the person's own machine, which has no pod behind it. It is the one thing
 *   about a chat that no title can say and that changes what the chat can do: it takes no files, cannot be stopped
 *   from here and answers only while the laptop is connected. `hasPod` is what decides it, so the screens and the
 *   stores cannot disagree. The state of its session rides along, because that is the other thing the person cannot
 *   see from the title and the mark is the only place it is said in the list.
 * - `assistant` — a chat running on their assistant's pod, marked only to tell it apart from a local one.
 * - `null` — nothing to mark. Every one of the person's chats runs on their assistant, so a cloud against each of
 *   them would distinguish them from nothing; see `hasLocalConversation`.
 */
export type ConversationMark = { where: "computer"; session: LocalSession } | { where: "assistant" } | null;

export interface ConversationLink {
  id: string;
  title: string;
  product: string;
  productLabel: string;
  lastActiveAt: string;
  mark: ConversationMark;
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
    modelRoute: assistant.modelRoute,
    needed,
    optional: optionalCredentials(assistant.modelRoute),
    logins: await loginViews(db, assistant.id),
    onboarded: onboarded(needed, stored),
    toChat: chatCredentials(needed, assistant.modelRoute)
  };
}

type LinkRow = Pick<ConversationListRow, "id" | "title" | "product" | "lastActiveAt" | "virtualAgentId" | "agentStatus">;

/** `anyLocal` is `hasLocalConversation`'s answer for the whole of the person's list; see `ConversationMark`. */
function markOf(row: LinkRow, anyLocal: boolean): ConversationMark {
  if (!hasPod(row)) {
    return { where: "computer", session: LOCAL_SESSION[row.agentStatus] };
  }
  return anyLocal ? { where: "assistant" } : null;
}

function toLink(row: LinkRow, anyLocal: boolean): ConversationLink {
  return {
    id: row.id,
    title: row.title ?? UNTITLED,
    product: row.product,
    productLabel: productLabel(row.product),
    lastActiveAt: row.lastActiveAt.toISOString(),
    mark: markOf(row, anyLocal)
  };
}

/** The chats running on one of the owner's virtual agents, for its page in the hub. */
export async function conversationLinks(db: Database, ownerOid: string, virtualAgentId: string): Promise<ConversationLink[]> {
  // Every chat here runs on the pod being asked about, so none of them is local; the question is still asked,
  // because `mark` is a statement about the person's list and not about the page that happens to be reading it.
  const [rows, anyLocal] = await Promise.all([listConversations(db, ownerOid, 200, virtualAgentId), hasLocalConversation(db, ownerOid)]);
  return rows.map((row) => toLink(row, anyLocal));
}

export async function conversationGroups(db: Database, ownerOid: string, now: Date = new Date()): Promise<{ label: DateGroup; items: ConversationLink[] }[]> {
  const [rows, anyLocal] = await Promise.all([listConversations(db, ownerOid), hasLocalConversation(db, ownerOid)]);
  return groupByDate(
    rows.map((row) => toLink(row, anyLocal)),
    (link) => new Date(link.lastActiveAt),
    now
  );
}

export interface ConversationMatch extends ConversationLink {
  /** Why the chat matched, when its title does not already show it: the words around the match in one message. */
  snippet: string | null;
}

/**
 * The viewer's own chats matching every word of `query`, for the sidebar's search.
 *
 * Marked through the same `toLink` and the same `hasLocalConversation` as the grouped list, so the search cannot
 * answer differently from the page for the same person: the mark is on the result rather than left to the browser to
 * work out from a list it can only see a page of.
 */
export async function conversationMatches(db: Database, ownerOid: string, query: string): Promise<ConversationMatch[]> {
  const [rows, anyLocal] = await Promise.all([searchConversations(db, ownerOid, query), hasLocalConversation(db, ownerOid)]);
  return rows.map((row) => ({ ...toLink(row, anyLocal), snippet: snippetOf(row.excerpt) }));
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
  /**
   * Where the chat runs, as `ConversationLink.local`. The one thing the chat's own screen reads it for is which of
   * its controls make sense: everything a pod does for a conversation — carrying a file to its session, interrupting
   * a turn, starting one on demand — there is nobody to do for a session on somebody's laptop.
   */
  local: boolean;
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
  // Read as the owner, deliberately: this page is only ever reached through `findConversation`, which is scoped to
  // the viewer's own chats, so by here the viewer *is* the owner and both reads below would answer nothing for
  // anyone else. The owner is passed rather than the caller's viewer so that stays true of this function on its own.
  // The ref carries the agent's id and its owner and nothing else, because that is all either read asks of it: the
  // literals are not a claim about the agent that some rule elsewhere has to keep agreeing with.
  const agent = { id: agentId, ownerOid: conversation.ownerOid };
  const [current, artefact, jira, confluence, page, questions, fork] = await Promise.all([
    db.agent.findUnique({ where: { id: agentId }, select: { status: true, skills: true, clientFeatures: true } }),
    readArtefact(db, conversation.id),
    readJiraExport(db, conversation.id),
    readConfluenceExport(db, conversation.id),
    agentConversation(db, conversation.ownerOid, agent),
    agentQuestions(db, conversation.ownerOid, agent),
    db.assistantConversation.findUnique({ where: { id: conversation.id }, select: FORKED_SELECT })
  ]);
  return {
    id: conversation.id,
    title: conversation.title ?? UNTITLED,
    product: conversation.product,
    productLabel: productLabel(conversation.product),
    productHistory: conversation.productHistory,
    stopHistory: conversation.stopHistory,
    local: !hasPod(conversation),
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
