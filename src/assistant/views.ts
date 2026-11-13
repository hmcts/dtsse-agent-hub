import { storedClientFeatures } from "../agents/client-features.ts";
import { repoFileBase } from "../agents/github.ts";
import { type Skill, storedSkills } from "../agents/skills.ts";
import type { CredentialKind } from "../credentials/names.ts";
import { type NavProjectRow, navProjects, searchProjects } from "../feedback/nav-store.ts";
import { feedbackEnabled } from "../feedback/settings.ts";
import { hasFeedbackProjects } from "../feedback/store.ts";
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
import { type Artefact, readArtefact } from "./artefact-store.ts";
import type { ConfluenceExportView } from "./confluence.ts";
import { readConfluenceExport } from "./confluence-store.ts";
import type { ConversationRow, ProductChange, SessionState, StopMark } from "./conversation-row.ts";
import {
  type ConversationListRow,
  hasLocalConversation,
  hasPodConversation,
  listConversations,
  sidebarConversations,
  unsentConversation
} from "./conversation-store.ts";
import { DECK_SELECT, type DeckSummary, deckSummary } from "./deck-store.ts";
import { FORKED_SELECT, type ForkedView, forkedView } from "./forks.ts";
import type { GithubExportView } from "./github.ts";
import { readGithubExport } from "./github-store.ts";
import { bySidebarOrder, groupForSidebar, type SidebarGroup } from "./grouping.ts";
import type { JiraExportView } from "./jira.ts";
import { readJiraExport } from "./jira-store.ts";
import { LOCAL_SESSION, type LocalSession } from "./local-session.ts";
import { chatCredentials, onboarded, type Readiness, readiness } from "./onboarding.ts";
import { hasPod } from "./pods.ts";
import { productLabel } from "./products.ts";
import { mergeMatches, searchTerms, snippetOf } from "./search.ts";
import { type ConversationMatchRow, searchConversations } from "./search-store.ts";
import { type MessageAttachment, unsentAttachments } from "./upload-store.ts";

/** The CFT Workspace as its pages show it. Only ever the viewer's own: nobody sees anyone else's assistant. */

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
 * Which of four states the session of a chat on the person's assistant is in: answering, connected and waiting,
 * on its way, or not connected and nothing on its way.
 *
 * Worked out from two reports. The agent's own status is first, as for a local chat: a session that is not
 * `offline` is connected whatever a supervisor report yet to land says, `busy` being mid-turn. Only an `offline`
 * agent looks at the pod's `sessionState`, where `starting` and `queued` are both "not connected yet, and the pod
 * is on it" — the difference between them is said in words on the chat's own page, and two shades of waiting would
 * be more than a list can carry. `live` on an offline agent is a heartbeat that has lapsed under a session the
 * supervisor still counts, and `null` is no report at all; both are not connected.
 */
export type PodSession = "ready" | "working" | "starting" | "disconnected";

export function podSessionOf(agentStatus: AgentStatus, sessionState: SessionState | null): PodSession {
  if (agentStatus === "busy") {
    return "working";
  }
  if (agentStatus === "idle") {
    return "ready";
  }
  return sessionState === "starting" || sessionState === "queued" ? "starting" : "disconnected";
}

/**
 * What a chat's row in the sidebar, and its result in the search, is marked with.
 *
 * Decided here rather than in either list, so a chat found by searching is marked exactly as the same chat in the
 * list below it:
 *
 * - `computer` — a Claude Code session on the person's own machine, which has no pod behind it (`hasPod`). The state
 *   of its session rides along, because the mark is the only place the list says it.
 * - `assistant` — a chat running on their assistant's pod, carrying its session's state; see `podSessionOf`.
 * - `null` — nothing to mark, because the person's list holds one kind of item only; see `showsMarks`.
 */
export type ConversationMark = { where: "computer"; session: LocalSession } | { where: "assistant"; session: PodSession } | null;

/** The kinds of item the sidebar lists: a chat on the person's computer, one on their pod, and a feedback project. */
export type SidebarKind = "local" | "cloud" | "feedback";

/**
 * Whether every row carries the icon of its kind. Only when the person's list holds more than one kind: an icon
 * against every row of a list with nothing else in it would distinguish it from nothing. Asked of the whole list
 * rather than the page the sidebar loaded, which is capped and so could miss the only item of another kind.
 */
export function showsMarks(kinds: ReadonlySet<SidebarKind>): boolean {
  return kinds.size > 1;
}

async function listMarked(db: Database, ownerOid: string): Promise<boolean> {
  const [local, cloud, feedback] = await Promise.all([
    hasLocalConversation(db, ownerOid),
    hasPodConversation(db, ownerOid),
    feedbackEnabled() ? hasFeedbackProjects(db, ownerOid) : false
  ]);
  const kinds: [SidebarKind, boolean][] = [
    ["local", local],
    ["cloud", cloud],
    ["feedback", feedback]
  ];
  return showsMarks(new Set(kinds.flatMap(([kind, has]) => (has ? [kind] : []))));
}

export interface ConversationLink {
  kind: "local" | "cloud";
  id: string;
  title: string;
  product: string;
  productLabel: string;
  lastActiveAt: string;
  /** When the owner pinned it, which puts it in the sidebar's Pinned section; null while it is not pinned. */
  pinnedAt: string | null;
  mark: ConversationMark;
}

/** A feedback project the viewer owns or is on the team of, as a sidebar row. */
export interface FeedbackProjectLink {
  kind: "feedback";
  id: string;
  title: string;
  lastActiveAt: string;
  /** When the viewer pinned it, for them alone. */
  pinnedAt: string | null;
  /** Whether the row carries the feedback icon; see `showsMarks`. */
  marked: boolean;
  unread: number;
  archivable: boolean;
  /** Its live share links, which the row's menu copies. */
  links: { label: string; token: string }[];
}

export type SidebarItem = ConversationLink | FeedbackProjectLink;

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

/**
 * The skills the assistant's pod reports, as the newest of its sessions to report any gave them: the same list the
 * composer's "/" menu offers in that session's chat. Every session on a pod loads the plugins the pod booted with, so
 * the newest stands for the pod running now.
 *
 * While the pod holds a launch token, only a session heard from since it was minted counts. A pod boots on a token
 * minted for it, and every path that replaces a pod — a restart, a change of size or plugins, a stop, a takeover —
 * drops the token first, which shuts the old pod's sessions out. So a session heard from since the mint is one of this
 * boot's, and one from an earlier boot, with the plugins that boot loaded, is passed over. With no token the pod is
 * stopped or not yet claimed, and the newest session of any boot stands for the next one: an idle or evening stop
 * changes no plugins, and the new chat's list would otherwise vanish every time the pod sleeps.
 *
 * A conversation's agent is created with no skills and a fresh heartbeat before its session registers, so a row with
 * none is passed over rather than read as a pod that has none. Empty until a session has reported its skills.
 */
export async function podSkills(db: Database, assistant: Pick<VirtualAgentRow, "id" | "ownerOid">): Promise<Skill[]> {
  const [newest] = await db.$queryRaw<{ skills: unknown }[]>`
    SELECT a.skills
      FROM agent a
      JOIN virtual_agent v ON v.id = a.virtual_agent_id
     WHERE v.id = ${assistant.id}::uuid
       AND a.owner_oid = ${assistant.ownerOid}
       AND a.skills <> '[]'::jsonb
       AND (v.launch_token_issued_at IS NULL OR a.last_heartbeat_at >= v.launch_token_issued_at)
     ORDER BY a.last_heartbeat_at DESC
     LIMIT 1
  `;
  return storedSkills(newest?.skills);
}

type LinkRow = Pick<ConversationListRow, "id" | "title" | "product" | "lastActiveAt" | "virtualAgentId" | "agentStatus" | "sessionState">;

/** `marked` is `listMarked`'s answer for the whole of the person's list; see `ConversationMark`. */
function markOf(row: LinkRow, marked: boolean): ConversationMark {
  if (!marked) {
    return null;
  }
  return hasPod(row)
    ? { where: "assistant", session: podSessionOf(row.agentStatus, row.sessionState) }
    : { where: "computer", session: LOCAL_SESSION[row.agentStatus] };
}

function toLink(row: LinkRow, marked: boolean): Omit<ConversationLink, "pinnedAt"> {
  return {
    kind: hasPod(row) ? "cloud" : "local",
    id: row.id,
    title: row.title ?? UNTITLED,
    product: row.product,
    productLabel: productLabel(row.product),
    lastActiveAt: row.lastActiveAt.toISOString(),
    mark: markOf(row, marked)
  };
}

function listLink(row: ConversationListRow, marked: boolean): ConversationLink {
  return { ...toLink(row, marked), pinnedAt: row.pinnedAt?.toISOString() ?? null };
}

function projectLink(row: NavProjectRow, marked: boolean): FeedbackProjectLink {
  return {
    kind: "feedback",
    id: row.id,
    title: row.name,
    lastActiveAt: row.lastActiveAt.toISOString(),
    pinnedAt: row.pinnedAt?.toISOString() ?? null,
    marked,
    unread: row.unread,
    archivable: row.archivable,
    links: row.links
  };
}

/** The chats running on one of the owner's virtual agents, for its page in the hub. */
export async function conversationLinks(db: Database, ownerOid: string, virtualAgentId: string): Promise<ConversationLink[]> {
  // `mark` is a statement about the person's whole list, not about the page that happens to be reading it.
  const [rows, marked] = await Promise.all([listConversations(db, ownerOid, 200, virtualAgentId), listMarked(db, ownerOid)]);
  return rows.map((row) => listLink(row, marked));
}

/** The sidebar: the viewer's chats and, while prototype feedback is on, their feedback projects, in one list. */
export async function sidebarGroups(db: Database, ownerOid: string, now: Date = new Date()): Promise<{ label: SidebarGroup; items: SidebarItem[] }[]> {
  const [{ pinned, recent }, projects, marked] = await Promise.all([
    sidebarConversations(db, ownerOid),
    feedbackEnabled() ? navProjects(db, ownerOid) : [],
    listMarked(db, ownerOid)
  ]);
  const items: SidebarItem[] = [...pinned, ...recent].map((row) => listLink(row, marked));
  items.push(...projects.map((row) => projectLink(row, marked)));
  return groupForSidebar(
    items.sort(bySidebarOrder),
    (item) => new Date(item.lastActiveAt),
    (item) => item.pinnedAt !== null,
    now
  );
}

/** A chat found by the sidebar's search, which says nothing of pinning: the results are one list in order of activity. */
export interface ConversationMatch extends Omit<ConversationLink, "pinnedAt"> {
  /** Why the chat matched, when its title does not already show it: the words around the match in one message. */
  snippet: string | null;
}

/** A feedback project found by the sidebar's search, by its name. */
export type FeedbackProjectMatch = Pick<FeedbackProjectLink, "kind" | "id" | "title" | "lastActiveAt" | "marked">;

export type SidebarMatch = ConversationMatch | FeedbackProjectMatch;

function chatMatch(row: ConversationMatchRow, marked: boolean): ConversationMatch {
  return { ...toLink(row, marked), snippet: snippetOf(row.excerpt) };
}

/**
 * The viewer's own chats matching every word of `query`. Marked through the same `toLink` and the same `listMarked`
 * as the grouped list, so the search cannot answer differently from the page for the same person.
 */
export async function conversationMatches(db: Database, ownerOid: string, query: string): Promise<ConversationMatch[]> {
  const [rows, marked] = await Promise.all([searchConversations(db, ownerOid, query), listMarked(db, ownerOid)]);
  return rows.map((row) => chatMatch(row, marked));
}

/** The sidebar's search: the chats `conversationMatches` finds, and the feedback projects the sidebar lists whose name matches. */
export async function sidebarMatches(db: Database, ownerOid: string, query: string): Promise<SidebarMatch[]> {
  const [rows, projects, marked] = await Promise.all([
    searchConversations(db, ownerOid, query),
    feedbackEnabled() ? searchProjects(db, ownerOid, searchTerms(query)) : [],
    listMarked(db, ownerOid)
  ]);
  return mergeMatches<SidebarMatch>(
    rows.map((row) => chatMatch(row, marked)),
    projects.map(({ id, name, lastActiveAt }) => ({ kind: "feedback", id, title: name, lastActiveAt: lastActiveAt.toISOString(), marked }))
  );
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
  /** Whether the owner pinned it, so its options menu offers Unpin rather than Pin. */
  pinned: boolean;
  productHistory: ProductChange[];
  /** Every answer the person stopped, so the thread shows where each one was cut off. */
  stopHistory: StopMark[];
  /**
   * Whether the chat has no pod (`!hasPod`). The one thing the chat's own screen reads it for is which of
   * its controls make sense: everything a pod does for a conversation — carrying a file to its session, interrupting
   * a turn, starting one on demand — there is nobody to do for a session on somebody's laptop.
   */
  local: boolean;
  agentId: string;
  agentStatus: AgentStatus;
  /**
   * Where a repo-relative path in an answer points, from the repo and branch the conversation's session registered;
   * `null` when it reported no repo. A session working in a clone cites paths rather than URLs, and without this the
   * whole of a `[text](path)` is shown as the text the author wrote.
   */
  repoBase: string | null;
  /**
   * What the composer's "/" autocomplete offers: the skills the conversation's session reported, or, on a pod before
   * that session has reported any, the pod's (`podSkills`), which its session will load too. A chat on a laptop has
   * no pod to ask, so it has none until its session reports them. No access check guards it, unlike the hub's agent
   * page: a conversation is only ever read by its owner, who is the only person who can message it.
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
  /** The latest version of the conversation's slide deck, without its outline, which the panel reads; `null` while it has none. */
  deck: DeckSummary | null;
  jira: JiraExportView;
  github: GithubExportView;
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
  // The fork's columns and the deck's are one read, and only the .pptx probe waits for it.
  const forkAndDeck = async () => {
    const row = await db.assistantConversation.findUnique({ where: { id: conversation.id }, select: { ...FORKED_SELECT, ...DECK_SELECT } });
    return { fork: row, deck: row === null ? null : await deckSummary(db, conversation.id, row) };
  };
  const [current, artefact, { fork, deck }, jira, github, confluence, page, questions] = await Promise.all([
    db.agent.findUnique({ where: { id: agentId }, select: { status: true, skills: true, clientFeatures: true, repo: true, branch: true } }),
    readArtefact(db, conversation.id),
    forkAndDeck(),
    readJiraExport(db, conversation.id),
    readGithubExport(db, conversation.id),
    readConfluenceExport(db, conversation.id),
    agentConversation(db, conversation.ownerOid, agent),
    agentQuestions(db, conversation.ownerOid, agent)
  ]);
  const ownSkills = storedSkills(current?.skills);
  const skills =
    ownSkills.length === 0 && hasPod(conversation) ? await podSkills(db, { id: conversation.virtualAgentId, ownerOid: conversation.ownerOid }) : ownSkills;
  return {
    id: conversation.id,
    title: conversation.title ?? UNTITLED,
    product: conversation.product,
    productLabel: productLabel(conversation.product),
    pinned: conversation.pinnedAt !== null,
    productHistory: conversation.productHistory,
    stopHistory: conversation.stopHistory,
    local: !hasPod(conversation),
    agentId,
    agentStatus: current?.status ?? "offline",
    repoBase: repoFileBase(current?.repo ?? null, current?.branch ?? null),
    skills,
    clientFeatures: storedClientFeatures(current?.clientFeatures),
    sessionState: conversation.sessionState,
    sessionDetail: conversation.sessionDetail,
    artefact: { ...artefact, updatedAt: artefact.updatedAt?.toISOString() ?? null },
    deck,
    jira,
    github,
    confluence,
    page,
    forked: fork === null ? null : forkedView(fork),
    questions
  };
}
