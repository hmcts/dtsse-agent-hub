import { HttpError } from "../agent-api/http.ts";
import { clientSupports } from "../agents/client-features.ts";
import { nameSourceOf } from "../agents/name-source.ts";
import { notify } from "../realtime/notify.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import type { ModelRoute } from "../viewer/identity.ts";
import { createVirtualAgent, findVirtualAgent, setDesired, type VirtualAgentRow } from "../virtual-agents/store.ts";
import { CONFLUENCE_SELECT, type ConfluenceExportFrame, pendingConfluenceExport } from "./confluence.ts";
import { JIRA_SELECT, type JiraExportFrame, pendingJiraExport } from "./jira.ts";
import { readAssistantModel } from "./model-store.ts";
import { hasPod } from "./pods.ts";
import { DEFAULT_PRODUCT, isProduct, productLabel, storedProduct } from "./products.ts";
import type { SessionsReport } from "./schemas.ts";
import { SEARCH_LIMIT, SNIPPET_MAX_WORDS, SNIPPET_MIN_WORDS, searchTerms, visibleMatches } from "./search.ts";
import { firstPromptTitle, localTitle, messageTitle, PROMPT_CANDIDATES, TITLE_MAX, type TitleSource } from "./titles.ts";
import { type FrameAttachment, frameAttachments } from "./upload-store.ts";

/**
 * The HMCTS Assistant: each person's one assistant virtual agent, and its conversations.
 *
 * A conversation's agent is created with it, offline and with a session id the hub chose, so a message can queue for
 * it before any session runs. The pod's supervisor starts a session under that id when the conversation is woken,
 * and the session's registration adopts the agent (`linkSession`). Every change is announced to the owner's UI and
 * to the assistant's sessions stream with an `assistant_conversation` event, inside the transaction that made it.
 */

export const ASSISTANT_NAME = "assistant";

const MAX_PRODUCT_HISTORY = 50;
const MAX_STOP_HISTORY = 50;

export class ConversationNotFound extends HttpError {
  constructor() {
    super(404, "no such conversation");
  }
}

export interface ConversationRow {
  id: string;
  ownerOid: string;
  /** The virtual agent whose pod runs its sessions, or null for a conversation that is a local session. */
  virtualAgentId: string | null;
  agentId: string | null;
  title: string | null;
  product: string;
  productHistory: ProductChange[];
  stopHistory: StopMark[];
  wakeRequestedAt: Date | null;
  sessionState: SessionState | null;
  sessionDetail: string | null;
  lastActiveAt: Date;
  createdAt: Date;
}

export type SessionState = "starting" | "live" | "queued";

export interface ProductChange {
  product: string;
  at: string;
}

/** When the person stopped an answer, which is where the thread shows that they did. */
export interface StopMark {
  at: string;
}

export interface Artefact {
  title: string | null;
  markdown: string;
  version: number;
  updatedBy: "user" | "agent" | null;
  updatedAt: Date | null;
}

const SELECT = {
  id: true,
  ownerOid: true,
  virtualAgentId: true,
  agentId: true,
  title: true,
  product: true,
  productHistory: true,
  stopHistory: true,
  wakeRequestedAt: true,
  sessionState: true,
  sessionDetail: true,
  lastActiveAt: true,
  createdAt: true
} as const;

function storedHistory(value: unknown): ProductChange[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (change): change is ProductChange => typeof change === "object" && change !== null && typeof change.product === "string" && typeof change.at === "string"
  );
}

function storedStops(value: unknown): StopMark[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((mark): mark is StopMark => typeof mark === "object" && mark !== null && typeof mark.at === "string");
}

function toRow(row: {
  id: string;
  ownerOid: string;
  virtualAgentId: string | null;
  agentId: string | null;
  title: string | null;
  product: string;
  productHistory: unknown;
  stopHistory: unknown;
  wakeRequestedAt: Date | null;
  sessionState: string | null;
  sessionDetail: string | null;
  lastActiveAt: Date;
  createdAt: Date;
}): ConversationRow {
  const state = row.sessionState;
  return {
    ...row,
    // A row reads as a product the list offers, so every page agrees with the picker. What a session is told does
    // not go through here: `assistantFrame` and `pendingWakes` carry the slug as stored.
    product: storedProduct(row.product),
    productHistory: storedHistory(row.productHistory),
    stopHistory: storedStops(row.stopHistory),
    sessionState: state === "starting" || state === "live" || state === "queued" ? state : null
  };
}

/**
 * Tells the owner's open tabs, and the pod's sessions stream, that the conversation changed; called inside the
 * transaction that changed it.
 *
 * Sent for a conversation with no pod as well, carrying a null `virtual_agent_id`. The owner's tabs are the
 * subscriber that matters here and `ui-stream` selects this frame on `owner_oid`, so having no pod means there is
 * nobody to *instruct*, not nobody to tell: a local chat renamed or deleted has to redraw like any other. The
 * sessions stream reaches no pod for it on its own, by comparing the id against a real one.
 */
export async function announce(db: Database, conversation: Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">): Promise<void> {
  await notify(db, {
    type: "assistant_conversation",
    conversation_id: conversation.id,
    virtual_agent_id: conversation.virtualAgentId,
    owner_oid: conversation.ownerOid
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * The virtual agent the person's Assistant runs on: their first, the oldest not being deleted. Any virtual agent can
 * hold conversations; the Assistant always uses the same one, so a person's chats are in one place.
 */
export async function findAssistant(db: Database, ownerOid: string): Promise<VirtualAgentRow | undefined> {
  const row = await db.virtualAgent.findFirst({
    where: { ownerOid, desired: { not: "deleted" } },
    select: { id: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }]
  });
  return row === null ? undefined : await findVirtualAgent(db, row.id);
}

/** `assistant`, or `assistant-2` and on when an earlier one of that name is still being deleted. */
async function freeName(db: Database, ownerOid: string): Promise<string> {
  const taken = new Set((await db.virtualAgent.findMany({ where: { ownerOid }, select: { name: true } })).map((row) => row.name));
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? ASSISTANT_NAME : `${ASSISTANT_NAME}-${n}`;
    if (!taken.has(name)) {
      return name;
    }
  }
}

/**
 * The virtual agent the person's Assistant runs on: their first, created as `assistant` when they have none, and
 * started whenever they come back to it stopped, so the pod is warming up while they sign in or type. It is an
 * ordinary virtual agent and counts towards their limit. Two tabs racing to create one are settled by the unique
 * name: the loser reads the winner's.
 */
export async function ensureAssistant(prisma: PrismaClient, owner: { oid: string; modelRoute: ModelRoute }): Promise<VirtualAgentRow> {
  const existing = await findAssistant(prisma, owner.oid);
  if (existing !== undefined) {
    return existing.desired === "stopped" ? await setDesired(prisma, owner.oid, existing.id, "running") : existing;
  }
  try {
    return await createVirtualAgent(prisma, { owner, modelRoute: owner.modelRoute, name: await freeName(prisma, owner.oid) });
  } catch (error) {
    const raced = await findAssistant(prisma, owner.oid);
    if (raced !== undefined) {
      return raced;
    }
    throw error;
  }
}

/** The conversation, if `ownerOid` owns it. Someone else's is reported as missing. */
export async function findConversation(db: Database, ownerOid: string, id: string): Promise<ConversationRow | undefined> {
  if (!isUuid(id)) {
    return undefined;
  }
  const row = await db.assistantConversation.findUnique({ where: { id }, select: SELECT });
  return row === null || row.ownerOid !== ownerOid ? undefined : toRow(row);
}

/**
 * The owner's conversations, most recently active first; only those on `virtualAgentId` when it is given.
 *
 * A conversation with no pod is listed outright. `virtualAgent: { desired: … }` is a relation filter on an optional
 * to-one, so a row with no related virtual agent does not satisfy it at all — reading the pod's state alone would
 * leave every local chat out of the sidebar rather than only the ones whose pod is going.
 */
export async function listConversations(db: Database, ownerOid: string, limit = 200, virtualAgentId?: string): Promise<ConversationRow[]> {
  const rows = await db.assistantConversation.findMany({
    where: {
      ownerOid,
      OR: [{ virtualAgentId: null }, { virtualAgent: { desired: { not: "deleted" } } }],
      ...(virtualAgentId === undefined ? {} : { virtualAgentId })
    },
    select: SELECT,
    orderBy: [{ lastActiveAt: "desc" }, { id: "asc" }],
    take: limit
  });
  return rows.map(toRow);
}

/**
 * The owner's newest conversation that exists only because the new-chat screen opened it for a file and nobody has
 * sent it yet: no message to or from any of its agents, no document, and at least one file finished uploading and
 * still unclaimed.
 *
 * This is what lets that screen survive being remounted. Without it the screen comes back with the draft text and no
 * conversation, sends, and starts a *second* conversation — leaving the first with the person's file in it for
 * `sweepUploads` to delete hours later, which is silent data loss.
 *
 * The conditions are the same ones `dropAbandoned` sweeps on, minus the retention window, which is deliberate: a
 * conversation is resumable for exactly as long as it is not yet rubbish. `state = 'stored'` rather than any
 * unclaimed upload, because a half-uploaded file cannot be sent and there is nothing to hand back.
 */
export async function unsentConversation(db: Database, ownerOid: string): Promise<ConversationRow | undefined> {
  const [row] = await db.$queryRaw<{ id: string }[]>`
    SELECT c.id::text AS id
      FROM assistant_conversation c
     WHERE c.owner_oid = ${ownerOid}
       AND c.artefact_version = 0
       AND c.forked_at IS NULL
       AND EXISTS (
             SELECT 1 FROM assistant_upload u
              WHERE u.conversation_id = c.id AND u.message_id IS NULL AND u.state = 'stored'
           )
       AND NOT EXISTS (
             SELECT 1 FROM message m
              WHERE m.target_agent_id IN (SELECT id FROM agent WHERE assistant_conversation_id = c.id)
                 OR m.author_agent_id IN (SELECT id FROM agent WHERE assistant_conversation_id = c.id)
           )
     ORDER BY c.created_at DESC
     LIMIT 1
  `;
  return row === undefined ? undefined : await findConversation(db, ownerOid, row.id);
}

/**
 * Every conversation id of the virtual agent, so its pod can reconcile its `/workspace/uploads/<id>/` directories
 * against them. A conversation deleted while the pod was stopped sends no `close`, so without this read its
 * attachments would stay on the disk until the volume went.
 */
export async function conversationIdsOf(db: Database, virtualAgentId: string): Promise<string[]> {
  const rows = await db.assistantConversation.findMany({ where: { virtualAgentId }, select: { id: true }, orderBy: { id: "asc" } });
  return rows.map((row) => row.id);
}

export interface ConversationMatchRow {
  id: string;
  ownerOid: string;
  /** Null for a match that is a session on the owner's own computer, which a result says as the sidebar's list does. */
  virtualAgentId: string | null;
  title: string | null;
  product: string;
  lastActiveAt: Date;
  /** The words of a message around the match, when a message rather than the title is why the chat matched. */
  excerpt: string | null;
}

/**
 * The owner's conversations whose title, or one of whose messages, carries every word of `query`; most recently
 * active first, the same order as the sidebar's list.
 *
 * Searching what was said and not only the titles is the point: a title is the first sixty characters of the first
 * message until someone renames it, so titles alone answer little more than "what did I open this with". Both halves
 * of the chat are searched, since what the Assistant answered is as much a landmark as what was asked.
 *
 * Every term is its own query, and each may be satisfied by the title or by any one message, so the words a person
 * remembers need not have been said together. `message_direct_body_search_idx` is what makes that affordable: the
 * index answers each term, and the owner's conversations are what the candidates are then joined back to. Nothing is
 * written on send beyond that index entry, and no body is carried out of the database — a result takes the words
 * around its own match through `ts_headline` and leaves the message where it is.
 *
 * A term the English dictionary has nothing to match on, such as "the", leaves `to_tsquery` empty; those are dropped
 * rather than left to refuse every chat. A query of nothing but those matches nothing at all, because `hit` is then
 * crossed with no queries.
 *
 * Transcript entries are left out on purpose. They are the session's whole working-out — tool calls, their results
 * and system lines — which the thread deliberately never shows, so matching them would answer with chats whose only
 * mention of "possession" was a file a search tool happened to open.
 */
export async function searchConversations(db: Database, ownerOid: string, query: string, limit = SEARCH_LIMIT): Promise<ConversationMatchRow[]> {
  const terms = searchTerms(query);
  if (terms.length === 0) {
    return [];
  }
  const rows = await db.$queryRaw<
    { id: string; ownerOid: string; virtualAgentId: string | null; title: string | null; product: string; lastActiveAt: Date; excerpt: string | null }[]
  >`
    WITH query AS (
      -- quote_literal is what makes a typed term safe to put in a query. A single-quoted string in a tsquery is
      -- re-lexed by the text-search parser, and several tokens out of one become a phrase, joined by <->, never
      -- boolean operators: so quoting a term can only narrow what it matches, and can never widen or negate it.
      -- It holds only on quote_literal's plain '…' form, which is why searchTerms has already taken the backslashes
      -- out: one of those switches it to E'…', which is not valid tsquery input at all. An empty query is a term the
      -- dictionary has nothing to match on, which is dropped rather than left to refuse every chat.
      SELECT n, tsq
        FROM unnest(${terms}::text[]) WITH ORDINALITY AS u(term, n),
             LATERAL (SELECT to_tsquery('english', quote_literal(u.term) || ':*') AS tsq) q
       WHERE tsq <> ''::tsquery
    ),
    owned AS (
      -- LEFT JOIN, with the null counted in: a conversation with no pod is one of the viewer's own chats and is
      -- searchable like any other. An inner join would drop every local chat from the sidebar's search, since there
      -- is no virtual_agent row for it to match.
      SELECT c.id, c.owner_oid, c.virtual_agent_id, c.title, c.product, c.last_active_at
        FROM assistant_conversation c
        LEFT JOIN virtual_agent v ON v.id = c.virtual_agent_id
       WHERE c.owner_oid = ${ownerOid} AND (v.id IS NULL OR v.desired <> 'deleted')
    ),
    in_body AS (
      SELECT DISTINCT ON (o.id, q.n) o.id AS conversation_id, q.n, m.body
        FROM query q
        JOIN message m ON m.kind = 'direct' AND to_tsvector('english', m.body) @@ q.tsq
        JOIN agent a ON m.target_agent_id = a.id OR m.author_agent_id = a.id
        JOIN owned o ON o.id = a.assistant_conversation_id
       ORDER BY o.id, q.n, m.id DESC
    ),
    hit AS (
      SELECT o.id, q.n, q.tsq, b.body
        FROM owned o
       CROSS JOIN query q
        LEFT JOIN in_body b ON b.conversation_id = o.id AND b.n = q.n
       WHERE to_tsvector('english', COALESCE(o.title, '')) @@ q.tsq OR b.body IS NOT NULL
    )
    SELECT o.id::text AS id, o.owner_oid AS "ownerOid", o.virtual_agent_id::text AS "virtualAgentId", o.title, o.product,
           o.last_active_at AS "lastActiveAt", e.excerpt
      FROM owned o
      JOIN (SELECT id FROM hit GROUP BY id HAVING count(*) = (SELECT count(*) FROM query)) matched ON matched.id = o.id
      LEFT JOIN LATERAL (
        SELECT ts_headline('english', h.body, h.tsq, ${`StartSel="", StopSel="", MaxWords=${SNIPPET_MAX_WORDS}, MinWords=${SNIPPET_MIN_WORDS}, MaxFragments=1`}) AS excerpt
          FROM hit h
         WHERE h.id = o.id AND h.body IS NOT NULL
         ORDER BY h.n
         LIMIT 1
      ) e ON TRUE
     ORDER BY o.last_active_at DESC, o.id
     LIMIT ${limit}
  `;
  // Nothing leaves the store carrying a product the list no longer offers, as `toRow` does for a whole conversation.
  return visibleMatches(
    ownerOid,
    rows.map((row) => ({ ...row, product: storedProduct(row.product) }))
  );
}

/**
 * Creates the conversation's agent: offline, the assistant's, under a session id the pod will start a session as.
 *
 * Refused for a conversation with no pod: the agent's name and its `virtual_agent_id` are read off the `virtual_agent`
 * row the insert selects from, so there is nothing to create the agent from. The same 409 the insert itself answers
 * when the virtual agent has gone, stated here rather than left to a `v.id = NULL` matching no row.
 */
export async function createConversationAgent(db: Database, conversation: Pick<ConversationRow, "id" | "ownerOid" | "virtualAgentId">): Promise<string> {
  if (!hasPod(conversation)) {
    throw new HttpError(409, "the assistant has gone");
  }
  const [agent] = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO agent (owner_oid, session_id, name, status, last_heartbeat_at, read_cursor, virtual_agent_id, assistant_conversation_id)
    SELECT ${conversation.ownerOid}, gen_random_uuid()::text, v.name, 'offline', now(), (SELECT COALESCE(max(id), 0) FROM message),
           v.id, ${conversation.id}::uuid
      FROM virtual_agent v
     WHERE v.id = ${conversation.virtualAgentId}::uuid
    RETURNING id::text AS id
  `;
  if (agent === undefined) {
    throw new HttpError(409, "the assistant has gone");
  }
  await db.assistantConversation.update({ where: { id: conversation.id }, data: { agentId: agent.id } });
  return agent.id;
}

export async function createConversation(
  prisma: PrismaClient,
  ownerOid: string,
  request: { product?: unknown; title?: string | null }
): Promise<ConversationRow> {
  const product = request.product === undefined ? DEFAULT_PRODUCT : request.product;
  if (!isProduct(product)) {
    throw new HttpError(400, "pick a product from the list");
  }
  const assistant = await findAssistant(prisma, ownerOid);
  if (assistant === undefined) {
    throw new HttpError(409, "open the Assistant first, so it can be set up");
  }
  const title = messageTitle(request.title ?? "");
  return await prisma.$transaction(async (tx) => {
    const created = await tx.assistantConversation.create({
      data: { ownerOid, virtualAgentId: assistant.id, product, title },
      select: SELECT
    });
    const agentId = await createConversationAgent(tx, created);
    await announce(tx, created);
    return { ...toRow(created), agentId };
  });
}

/**
 * Creates the conversation of a local session: no pod, the session's own agent as its current one, and the default
 * product.
 *
 * A sibling of `createConversation` rather than a branch of it, because the two share none of their steps. That one
 * needs the person's assistant and creates an agent for the pod to start a session as; here the agent is the session
 * that is already running on somebody's laptop, so there is no pod to find and nothing to create.
 */
export async function createLocalConversation(db: Database, session: { ownerOid: string; agentId: string; title: string | null }): Promise<ConversationRow> {
  const created = await db.assistantConversation.create({
    data: {
      ownerOid: session.ownerOid,
      virtualAgentId: null,
      agentId: session.agentId,
      product: DEFAULT_PRODUCT,
      title: session.title,
      // Whatever the session's client reported, which is as weak as a title gets: `refreshLocalTitle` replaces
      // it with the chat's first prompt as soon as the session uploads one.
      titleSource: "agent" satisfies TitleSource
    },
    select: SELECT
  });
  await announce(db, created);
  return toRow(created);
}

/**
 * Marks the conversation as needing a session, and starts its assistant if it is stopped. A wake already pending
 * keeps its time, so the sessions stream replays wakes in the order they were asked for.
 *
 * Nothing at all for a conversation with no pod, and the column is left null rather than written and left for
 * something to clear. A wake is an instruction to a pod's supervisor — `pendingWakes` selects on the virtual agent,
 * so no stream carries one for a conversation that has none — and nothing clears it either: `linkLocalSession`
 * deliberately does not, because a laptop registering is not a supervisor reporting it started what the hub asked
 * for, and `reportSessions` only ever sees a pod's own conversations. So a wake recorded here would be a row that
 * said a session had been asked for, for ever, with nobody having been asked and nothing able to answer.
 */
export async function requestWake(prisma: PrismaClient, conversation: ConversationRow, now: Date = new Date()): Promise<void> {
  if (!hasPod(conversation)) {
    return;
  }
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE assistant_conversation
         SET wake_requested_at = COALESCE(wake_requested_at, ${now}), last_active_at = ${now}, updated_at = ${now}
       WHERE id = ${conversation.id}::uuid
    `;
    await announce(tx, conversation);
  });
  const assistant = await findVirtualAgent(prisma, conversation.virtualAgentId);
  if (assistant?.desired === "stopped") {
    await setDesired(prisma, conversation.ownerOid, assistant.id, "running", now);
  }
}

/** Why a stop did nothing, or `stopped` when it did. Each one is something to tell the person, not an error. */
export type StopOutcome = "stopped" | "nothing-running" | "unsupported-client";

/**
 * Stops the answer the conversation's session is working on: records it on the conversation, so the thread shows
 * where the answer was cut off, and tells the pod to interrupt the session.
 *
 * Only while the hub can see a turn to stop. The `interrupt` is sent once and never replayed, so a stop asked for
 * after the answer landed would reach a session that had moved on — and recording one that interrupted nothing would
 * put a line in the thread saying the person stopped an answer that in fact finished. `busy` on the conversation's
 * current agent is that check: the session's own hooks write it, and the bridge sends it on within seconds of a turn
 * starting or ending.
 *
 * Refused outright for a session whose client never claimed `stop`, which would ignore the frame in silence. That
 * claim is also what the UI gates its stop control on, so this is the second line of the same defence rather than
 * the one the person normally meets.
 *
 * `nothing-running` for a conversation with no pod, for the same reason as one with no agent: the stop is an
 * `assistant_stop` to the conversation's pod, and there is no pod to send it to.
 */
export async function stopAnswer(prisma: PrismaClient, conversation: ConversationRow, now: Date = new Date()): Promise<StopOutcome> {
  if (!hasPod(conversation) || conversation.agentId === null) {
    return "nothing-running";
  }
  const agent = await prisma.agent.findUnique({ where: { id: conversation.agentId }, select: { status: true, clientFeatures: true } });
  if (agent === null || agent.status !== "busy") {
    return "nothing-running";
  }
  if (!clientSupports(agent.clientFeatures, "stop")) {
    return "unsupported-client";
  }
  const history = [...conversation.stopHistory, { at: now.toISOString() }].slice(-MAX_STOP_HISTORY);
  await prisma.$transaction(async (tx) => {
    // Written as `setProduct` writes the product history, rather than through the typed client: Prisma's JSON input
    // type takes no array of a named interface, and the two histories are better off written the same way.
    await tx.$executeRaw`
      UPDATE assistant_conversation
         SET stop_history = ${JSON.stringify(history)}::jsonb, updated_at = ${now}
       WHERE id = ${conversation.id}::uuid
    `;
    // The pod acts on `assistant_stop`; the announcement beside it is what redraws the thread for the person.
    await announce(tx, conversation);
    await notify(tx, {
      type: "assistant_stop",
      conversation_id: conversation.id,
      virtual_agent_id: conversation.virtualAgentId,
      owner_oid: conversation.ownerOid
    });
  });
  return "stopped";
}

/** The conversation's agent, created again if it has none, so there is always somewhere for a message to queue. */
export async function conversationAgent(prisma: PrismaClient, conversation: ConversationRow): Promise<string> {
  if (conversation.agentId !== null) {
    return conversation.agentId;
  }
  return await prisma.$transaction(async (tx) => {
    const agentId = await createConversationAgent(tx, conversation);
    await announce(tx, conversation);
    return agentId;
  });
}

/**
 * Activity on the conversation: it moves up the list, and a first message names it.
 *
 * Only while it has no title at all, which is the precedent `refreshLocalTitle` follows for a chat on somebody's
 * own computer. A local chat reaches here with the name its session reported already on it, so a message sent into
 * one from the hub leaves that name standing and the chat's own first prompt is what replaces it.
 */
export async function touchConversation(prisma: PrismaClient, conversation: ConversationRow, firstMessage: string, now: Date = new Date()): Promise<void> {
  const title = conversation.title === null ? messageTitle(firstMessage) : null;
  await prisma.$transaction(async (tx) => {
    await tx.assistantConversation.update({
      where: { id: conversation.id },
      data: { ...(title === null ? {} : { title, titleSource: "message" satisfies TitleSource }), lastActiveAt: now, updatedAt: now }
    });
    await announce(tx, conversation);
  });
}

/**
 * A session registered for the conversation: its agent becomes the conversation's current one, the wake is
 * answered, and the session counts as activity for the assistant's idle stop. Called inside the registration's
 * transaction, which has already checked that the conversation is the registering virtual agent's.
 */
export async function linkSession(
  db: Database,
  session: { conversationId: string; virtualAgentId: string; ownerOid: string; agentId: string },
  now: Date = new Date()
): Promise<void> {
  await db.assistantConversation.update({
    where: { id: session.conversationId },
    data: { agentId: session.agentId, wakeRequestedAt: null, sessionState: "live", sessionDetail: null, updatedAt: now }
  });
  await db.virtualAgent.update({ where: { id: session.virtualAgentId }, data: { lastActiveAt: now, updatedAt: now } });
  await announce(db, { id: session.conversationId, virtualAgentId: session.virtualAgentId, ownerOid: session.ownerOid });
}

/**
 * A laptop session's conversation, created and linked to the session's own agent; called inside the registration's
 * transaction. Answers the conversation, or `undefined` when the agent was already in one.
 *
 * Named after `linkSession` and deliberately not it: that one sets `sessionState` to `live` and clears the wake,
 * which is a pod's supervisor reporting that it has started the session the hub asked for. A laptop has no
 * supervisor and the hub asked for nothing, so neither field means anything here and both stay null.
 *
 * The link is a conditional update rather than a column of the registration's upsert, whose `SET` list leaves
 * `assistant_conversation_id` alone — that is what lets this link survive a re-registration, which sends no
 * conversation of any kind. Zero rows means another transaction linked the agent first, so this conversation goes and
 * theirs stands; the registration itself is unaffected either way. The announcement already made for the one removed
 * redraws a sidebar that then lists nothing new, which is cheaper than holding the announcement back for a case the
 * caller's lock already rules out.
 */
export async function linkLocalSession(db: Database, session: { ownerOid: string; agentId: string; name: string }): Promise<ConversationRow | undefined> {
  const created = await createLocalConversation(db, { ownerOid: session.ownerOid, agentId: session.agentId, title: localTitle(session.name) });
  const linked = await db.$executeRaw`
    UPDATE agent
       SET assistant_conversation_id = ${created.id}::uuid
     WHERE id = ${session.agentId}::uuid AND assistant_conversation_id IS NULL
  `;
  if (linked === 0) {
    await db.assistantConversation.delete({ where: { id: created.id } });
    return undefined;
  }
  return created;
}

/**
 * Writes a title the hub derived for a chat with no pod, and announces it when it landed.
 *
 * Every condition is repeated here rather than trusted from the caller's read, so two uploads for one session
 * racing cannot both name it: the second blocks on the row, re-reads it and matches nothing. `replaceable` is which
 * titles this derivation outranks, and `IS DISTINCT FROM` is what makes a derivation that agrees with the row cost
 * one statement and no write — including the common case of the same `/rename` arriving on upload after upload.
 */
async function nameLocalChat(
  db: Database,
  conversation: { id: string; ownerOid: string },
  title: string,
  source: TitleSource,
  replaceable: readonly TitleSource[],
  now: Date
): Promise<void> {
  const named = await db.$executeRaw`
    UPDATE assistant_conversation
       SET title = ${title}, title_source = ${source}, updated_at = ${now}
     WHERE id = ${conversation.id}::uuid
       AND virtual_agent_id IS NULL
       AND title_source = ANY(${replaceable}::text[])
       AND title IS DISTINCT FROM ${title}
  `;
  if (named > 0) {
    await announce(db, { id: conversation.id, virtualAgentId: null, ownerOid: conversation.ownerOid });
  }
}

/**
 * Keeps the title of a chat on somebody's own computer in step with the best name available for it. Called from the
 * transcript upload inside its transaction — the moment the hub learns what the person typed — and does nothing at
 * all for a chat with a pod, or for one whose owner has renamed it in the hub.
 *
 * Two derivations, strongest first:
 *
 * - **The session's name, when the person chose it** (`name_source = 'user'`, which is Claude Code's `/rename`).
 *   That is the person saying what this session is, so it outranks the chat's own prompts and replaces a title
 *   already taken from one. The chat keeps `title_source = 'agent'`, because the title still follows the session's
 *   name and a second `/rename` should move it again.
 * - **The chat's first prompt**, while the title is still the name the client reported. The hub can name a local
 *   chat better than its client can: the client has only the session's own name to offer, which it derives from the
 *   transcript's conversation title and which is the session registry's `hmcts-25` at the moment the session
 *   registers and its chat is made. A chat's first prompt is what the chat is about, which is already how a chat on
 *   a pod is named (`touchConversation`). `firstPromptTitle` decides which prompt — a redacted or relayed one names
 *   nothing.
 *
 * The prompts are read by agent rather than by conversation because a local chat has exactly one: `linkLocalSession`
 * links the session's own agent and `conversationAgent`, which is what ever makes a second, refuses a chat with no
 * pod. That keeps the read on `transcript_entry_agent_id_occurred_at_id_idx`, and it is only reached while a prompt
 * could still claim the title — after that this is one indexed read per upload and nothing else.
 */
export async function refreshLocalTitle(db: Database, agentId: string, now: Date = new Date()): Promise<void> {
  const agent = await db.agent.findUnique({
    where: { id: agentId },
    select: { name: true, nameSource: true, assistantConversation: { select: { id: true, ownerOid: true, virtualAgentId: true, titleSource: true } } }
  });
  const conversation = agent?.assistantConversation ?? null;
  if (agent === null || conversation === null || conversation.virtualAgentId !== null || conversation.titleSource === "user") {
    return;
  }
  if (nameSourceOf(agent.nameSource) === "user") {
    const chosen = localTitle(agent.name);
    if (chosen !== null) {
      await nameLocalChat(db, conversation, chosen, "agent", ["agent", "message"], now);
    }
    return;
  }
  if (conversation.titleSource !== "agent") {
    return;
  }
  const prompts = await db.transcriptEntry.findMany({
    where: { agentId, role: "user" },
    select: { content: true, redacted: true, messageId: true },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    take: PROMPT_CANDIDATES
  });
  const title = firstPromptTitle(prompts);
  if (title !== null) {
    await nameLocalChat(db, conversation, title, "message", ["agent"], now);
  }
}

/**
 * What the pod's supervisor runs, replacing its last report: every conversation of the assistant it leaves out has
 * no session. Only conversations whose state changed are announced. Not activity for the idle stop, which a pod
 * reporting every minute would otherwise never reach.
 *
 * A session reported `live` answers the conversation's wake, as a registration does. A registration cannot be
 * relied on for that: a conversation resumed on a new pod never registers again, because its session finds the
 * `enabled` file the pod before it left on the volume and skips the enable that would have. Left pending, its wake
 * is replayed on every sessions stream the pod opens, and `fill()` takes the oldest wake first — so a handful of
 * resumed conversations take each other's slots in turn for ever and no one of them keeps a session long enough to
 * answer. Nothing is stranded by clearing it: a pod that loses its sessions leaves their agents silent, and the
 * offline sweep is what the person's next message and the warm on opening a conversation ask for a wake on.
 *
 * The report's `max` is kept as well, because it is the only account of what the pod in front of the person actually
 * enforces: the cap is in the pod template, so raising the constant reaches a running pod when it next rolls and the
 * two disagree until then. `chatCapacity` is what reads it, and gives no current figure at all when it is null or
 * the pod has stopped. Written on every report rather than only when it changes — it is one integer on a row this
 * already touches, and a pod that rolled onto a new cap says so with its first report rather than waiting for a
 * session to start or stop.
 */
export async function reportSessions(prisma: PrismaClient, virtualAgentId: string, report: SessionsReport, now: Date = new Date()): Promise<void> {
  const reported = new Map(report.sessions.map((session) => [session.conversation_id, session]));
  await prisma.$transaction(async (tx) => {
    await tx.virtualAgent.updateMany({ where: { id: virtualAgentId }, data: { sessionsMax: report.max, updatedAt: now } });
    const rows = await tx.assistantConversation.findMany({
      where: { virtualAgentId },
      select: { id: true, ownerOid: true, virtualAgentId: true, sessionState: true, sessionDetail: true, wakeRequestedAt: true }
    });
    for (const row of rows) {
      const session = reported.get(row.id);
      const state = session?.state ?? null;
      const detail = session?.detail ?? null;
      // Only `live`, not `starting`: a session still starting may yet fail, and its wake is what starts it again.
      const woken = state === "live" && row.wakeRequestedAt !== null;
      if (row.sessionState !== state || row.sessionDetail !== detail || woken) {
        await tx.assistantConversation.update({
          where: { id: row.id },
          data: { sessionState: state, sessionDetail: detail, ...(woken ? { wakeRequestedAt: null } : {}), updatedAt: now }
        });
        await announce(tx, row);
      }
    }
  });
}

export async function renameConversation(prisma: PrismaClient, ownerOid: string, id: string, title: string): Promise<void> {
  const trimmed = title.trim().replace(/\s+/g, " ");
  if (trimmed === "" || trimmed.length > TITLE_MAX) {
    throw new HttpError(400, `a title is 1 to ${TITLE_MAX} characters`);
  }
  const conversation = await findConversation(prisma, ownerOid, id);
  if (conversation === undefined) {
    throw new ConversationNotFound();
  }
  await prisma.$transaction(async (tx) => {
    // `user` is what makes this the last word on the title: nothing the hub derives replaces one a person chose.
    await tx.assistantConversation.update({ where: { id }, data: { title: trimmed, titleSource: "user" satisfies TitleSource, updatedAt: new Date() } });
    await announce(tx, conversation);
  });
}

/**
 * The product the conversation is about from now on. Each change is kept, so the thread can show where it changed;
 * the session is told with the next message it is sent, in that message's frame.
 */
export async function setProduct(prisma: PrismaClient, ownerOid: string, id: string, product: unknown, now: Date = new Date()): Promise<void> {
  if (!isProduct(product)) {
    throw new HttpError(400, "pick a product from the list");
  }
  const conversation = await findConversation(prisma, ownerOid, id);
  if (conversation === undefined) {
    throw new ConversationNotFound();
  }
  const history = [...conversation.productHistory, { product, at: now.toISOString() }].slice(-MAX_PRODUCT_HISTORY);
  await prisma.$transaction(async (tx) => {
    // The row decides whether this is a change, because a conversation left on a slug the list no longer offers
    // reads as the default: picking that default is a real change, which this stores and records in the history.
    const changed = await tx.$executeRaw`
      UPDATE assistant_conversation
         SET product = ${product}, product_history = ${JSON.stringify(history)}::jsonb, updated_at = ${now}
       WHERE id = ${id}::uuid AND product <> ${product}
    `;
    if (changed > 0) {
      await announce(tx, conversation);
    }
  });
}

/**
 * Removes the conversation from the person's Assistant. How much goes with it depends on whether it has a pod,
 * because that decides what its agent is.
 *
 * A pod conversation's agent exists only to be this chat's session: the hub created it with the conversation, it is
 * its owner's and nobody else can see or message it, and no post may tag it. So it goes too — and with it, by cascade, its transcript,
 * its deliveries and its subscriptions — along with every direct message to or from it, since those are the words of
 * the chat. The announcement tells the pod to stop the session.
 *
 * A conversation with no pod is detached instead: `agent.assistant_conversation_id` is cleared and the row then
 * deleted, and no message is touched. Its agent is a session running on the person's own laptop and one of their
 * ordinary sessions — on the hub roster, taggable in anyone's post, holding the transcript it
 * uploaded, its topic subscriptions, its questions and a direct thread that includes board messages with colleagues
 * that have nothing to do with this chat. Deleting the conversation row without clearing the column first would
 * cascade through all of that, and the session would then 404, re-register as a brand-new agent and bring the chat
 * back. Removing a chat is about the chat; the session on the laptop is left exactly as it was.
 */
export async function deleteConversation(prisma: PrismaClient, ownerOid: string, id: string): Promise<void> {
  const conversation = await findConversation(prisma, ownerOid, id);
  if (conversation === undefined) {
    throw new ConversationNotFound();
  }
  const pod = hasPod(conversation);
  await prisma.$transaction(async (tx) => {
    if (pod) {
      await tx.$executeRaw`
        DELETE FROM message
         WHERE kind = 'direct'
           AND (target_agent_id IN (SELECT id FROM agent WHERE assistant_conversation_id = ${id}::uuid)
                OR author_agent_id IN (SELECT id FROM agent WHERE assistant_conversation_id = ${id}::uuid))
      `;
    } else {
      await tx.$executeRaw`UPDATE agent SET assistant_conversation_id = NULL WHERE assistant_conversation_id = ${id}::uuid`;
    }
    await tx.assistantConversation.delete({ where: { id } });
    await announce(tx, conversation);
  });
}

const EMPTY_ARTEFACT: Artefact = { title: null, markdown: "", version: 0, updatedBy: null, updatedAt: null };

function toArtefact(row: {
  artefactTitle: string | null;
  artefactMarkdown: string;
  artefactVersion: number;
  artefactUpdatedBy: string | null;
  artefactUpdatedAt: Date | null;
}): Artefact {
  const by = row.artefactUpdatedBy;
  return {
    title: row.artefactTitle,
    markdown: row.artefactMarkdown,
    version: row.artefactVersion,
    updatedBy: by === "user" || by === "agent" ? by : null,
    updatedAt: row.artefactUpdatedAt
  };
}

const ARTEFACT_SELECT = { artefactTitle: true, artefactMarkdown: true, artefactVersion: true, artefactUpdatedBy: true, artefactUpdatedAt: true } as const;

export async function readArtefact(db: Database, conversationId: string): Promise<Artefact> {
  const row = await db.assistantConversation.findUnique({ where: { id: conversationId }, select: ARTEFACT_SELECT });
  return row === null ? EMPTY_ARTEFACT : toArtefact(row);
}

/** The conversation an agent is a session of, for the agent API's artefact routes. */
export async function conversationOfAgent(db: Database, agentId: string): Promise<ConversationRow | undefined> {
  const row = await db.agent.findUnique({ where: { id: agentId }, select: { assistantConversation: { select: SELECT } } });
  return row?.assistantConversation === null || row?.assistantConversation === undefined ? undefined : toRow(row.assistantConversation);
}

export class ArtefactConflict extends Error {
  readonly current: Artefact;

  constructor(current: Artefact) {
    super("the document has changed since that version");
    this.current = current;
  }
}

/**
 * Writes the conversation's artefact if `baseVersion` is still its version, and answers the new one. Otherwise
 * nothing is written and `ArtefactConflict` carries what is there now, for the writer to merge into. A title left
 * `null` keeps the current one.
 */
export async function writeArtefact(
  prisma: PrismaClient,
  conversation: Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">,
  write: { title: string | null; markdown: string; baseVersion: number; by: "user" | "agent" },
  now: Date = new Date()
): Promise<number> {
  return await prisma.$transaction(async (tx) => {
    const updated = await tx.$queryRaw<{ version: number }[]>`
      UPDATE assistant_conversation
         SET artefact_title = COALESCE(${write.title}, artefact_title, 'Untitled document'),
             artefact_markdown = ${write.markdown},
             artefact_version = artefact_version + 1,
             artefact_updated_by = ${write.by},
             artefact_updated_at = ${now},
             updated_at = ${now}
       WHERE id = ${conversation.id}::uuid AND artefact_version = ${write.baseVersion}::int
      RETURNING artefact_version AS version
    `;
    const [row] = updated;
    if (row === undefined) {
      throw new ArtefactConflict(await readArtefact(tx, conversation.id));
    }
    await announce(tx, conversation);
    return row.version;
  });
}

/**
 * What a direct frame to a conversation's agent carries, or `undefined` for any other agent.
 *
 * A field only some clients read belongs behind a claim, left out of the frame for a client that did not claim it, so
 * the hub does not send where it cannot be read; `client_features` on register (`src/agents/client-features.ts`) is
 * what says which client claimed what. No field here is gated on a claim, and two of them are not read by every
 * published client: `attachments`, `jira_export` and `confluence_export`. All three go to every session.
 *
 * A client older than attachments drops that message's files in silence. Gating `attachments` is two lines:
 *   1. `clientFeatures: true` in the `select` below. It is free: a column of the `agent` row this read already
 *      fetches, so it widens the projection and adds no statement;
 *   2. `...(clientSupports(row.clientFeatures, "attachments") ? { attachments } : {})` in the returned frame.
 *
 * Those two close the hub's half only — the field stops reaching a session that cannot act on it. They do not close
 * the silence: an old client receives no `attachments`, still drops the files, and the person is still told nothing.
 * Saying so is a third change, and it is not built. `ConversationView.clientFeatures` (`src/assistant/views.ts`) is
 * what carries the claim to the screen for it, and nothing reads that field today.
 *
 * The published client claims `attachments` (`CLIENT_FEATURES` in `packages/agent-hub/src/features.ts`), so the gate
 * answers true for a session on a current build. A session registered by a build published before that claim claims
 * nothing and loses the field until it restarts: a pod takes the current client on boot and every session reports its
 * claim on register, so the window is the life of the sessions already running, not anything to migrate.
 *
 * `jira_export` is the same silence and a different gate. A client older than the export reads no steps off the frame,
 * so the session is handed the person's request in words and left to improvise, and the export fails on its 15-minute
 * timeout; leaving the field out of the frame changes none of that. The claim belongs one step earlier, where the
 * person can be told: `exportArtefactToJira` refusing an export the conversation's session could not carry out, as
 * `canStopAssistantAnswer` refuses a stop. That is not built, and the published client claims no `jira_export`.
 * `confluence_export` is the same case and is left the same way.
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
  /** While an export to Jira is pending: what to create, which the session carries out with `twg`. */
  jira_export?: JiraExportFrame;
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

/** `messageId` is the direct being framed, which is what the attachments hang off. */
export async function assistantFrame(db: Database, agentId: string, messageId?: bigint): Promise<AssistantFrame | undefined> {
  const row = await db.agent.findUnique({
    where: { id: agentId },
    select: {
      assistantConversation: {
        select: { id: true, ownerOid: true, product: true, ...ARTEFACT_SELECT, ...JIRA_SELECT, ...CONFLUENCE_SELECT }
      }
    }
  });
  const conversation = row?.assistantConversation;
  if (conversation === null || conversation === undefined) {
    return undefined;
  }
  const artefact = toArtefact(conversation);
  const jira = pendingJiraExport(conversation);
  const confluence = pendingConfluenceExport(conversation);
  return {
    conversation_id: conversation.id,
    // What the conversation is stored as, not what the picker can show: this is the subject the session has been
    // working in, and a product dropped from the list still names it. `productLabel` falls back to the slug.
    product: conversation.product,
    product_label: productLabel(conversation.product),
    model: await readAssistantModel(db, conversation.ownerOid),
    artefact_version: artefact.version,
    artefact_updated_by: artefact.updatedBy,
    ...(jira === undefined ? {} : { jira_export: jira }),
    ...(confluence === undefined ? {} : { confluence_export: confluence }),
    ...(messageId === undefined ? {} : { attachments: await frameAttachments(db, messageId) })
  };
}

/** A wake on the sessions stream: the conversation needs a session, under this session id. */
export interface Wake {
  conversation_id: string;
  session_id: string;
  resume: boolean;
  product: string;
  /** The model to start the session on, which the pod passes to its launcher as `--model`. */
  model: string;
}

/**
 * Every pending wake of the assistant, oldest first. `resume` once the session has sent a transcript entry. The
 * product is the stored one, as the frame's is: what the pod is told is what the conversation holds. The model is
 * the owner's one choice, as the frame's is, so every session the pod starts runs on what they picked.
 */
export async function pendingWakes(db: Database, virtualAgentId: string): Promise<Wake[]> {
  const rows = await db.$queryRaw<(Omit<Wake, "model"> & { owner_oid: string })[]>`
    SELECT c.id::text AS conversation_id, a.session_id, EXISTS (SELECT 1 FROM transcript_entry t WHERE t.agent_id = a.id) AS resume, c.product, c.owner_oid
      FROM assistant_conversation c
      JOIN agent a ON a.id = c.agent_id
     WHERE c.virtual_agent_id = ${virtualAgentId}::uuid AND c.wake_requested_at IS NOT NULL
     ORDER BY c.wake_requested_at, c.id
  `;
  const owner = rows[0]?.owner_oid;
  if (owner === undefined) {
    return [];
  }
  // Every conversation on a virtual agent is its owner's, so one read answers for all of these rows.
  const model = await readAssistantModel(db, owner);
  return rows.map(({ owner_oid: _owner, ...wake }) => ({ ...wake, model }));
}

/** The wake for one conversation, if it has one pending; `null` when the conversation is gone. */
export async function pendingWake(db: Database, virtualAgentId: string, conversationId: string): Promise<Wake | undefined | null> {
  const exists = await db.assistantConversation.count({ where: { id: conversationId, virtualAgentId } });
  if (exists === 0) {
    return null;
  }
  const wakes = await pendingWakes(db, virtualAgentId);
  return wakes.find((wake) => wake.conversation_id === conversationId);
}
