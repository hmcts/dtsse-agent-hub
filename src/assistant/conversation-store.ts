import { isOwner } from "../access/rules.ts";
import { HttpError } from "../agent-api/http.ts";
import { isUuid } from "../agents/ids.ts";
import type { AgentStatus } from "../realtime/events.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { findAssistant } from "./assistant-store.ts";
import { announce, ConversationNotFound, type ConversationRow, SELECT, toRow } from "./conversation-row.ts";
import { detachLocalSessions, markChatRemoved } from "./local-chat-store.ts";
import { hasPod } from "./pods.ts";
import { DEFAULT_PRODUCT, isProduct } from "./products.ts";
import { messageTitle, TITLE_MAX, type TitleSource } from "./titles.ts";

/**
 * The CFT Workspace's conversations: reading, listing, creating, renaming and removing them.
 *
 * A conversation's agent is created with it, offline and with a session id the hub chose, so a message can queue for
 * it before any session runs. The pod's supervisor starts a session under that id when the conversation is woken,
 * and the session's registration adopts the agent (`linkSession`). Every change is announced to the owner's UI and
 * to the assistant's sessions stream with an `assistant_conversation` event, inside the transaction that made it.
 */

const MAX_PRODUCT_HISTORY = 50;

/** The conversation, if `ownerOid` owns it. Someone else's is reported as missing. */
export async function findConversation(db: Database, ownerOid: string, id: string): Promise<ConversationRow | undefined> {
  if (!isUuid(id)) {
    return undefined;
  }
  const row = await db.assistantConversation.findUnique({ where: { id }, select: SELECT });
  return row === null || !isOwner(ownerOid, row) ? undefined : toRow(row);
}

/**
 * A listed conversation with the status of its current agent, which is what a sidebar row needs and a conversation's
 * own row does not carry: `agent_id` names the agent, and the status lives on that agent.
 */
export interface ConversationListRow extends ConversationRow {
  /** The status of the conversation's current agent; `offline` when it has no agent yet, as its own page reads it. */
  agentStatus: AgentStatus;
}

/**
 * The owner's conversations with anything in them (`first_content_at`, see `announceFirstContent`), most recently
 * active first; only those on `virtualAgentId` when it is given.
 *
 * A conversation with no pod needs nothing more to be listed. `virtualAgent: { desired: … }` is a relation filter on an optional
 * to-one, so a row with no related virtual agent does not satisfy it at all — reading the pod's state alone would
 * leave every local chat out of the sidebar rather than only the ones whose pod is going.
 *
 * The current agent's status comes back with each row, because the sidebar colours a local chat's mark by it: a
 * second read per row would be one query per chat, and one read of the whole list is what keeps the mark and the
 * chat's own page saying the same thing about the same session.
 */
export async function listConversations(db: Database, ownerOid: string, limit = 200, virtualAgentId?: string): Promise<ConversationListRow[]> {
  const rows = await db.assistantConversation.findMany({
    where: {
      ownerOid,
      firstContentAt: { not: null },
      OR: [{ virtualAgentId: null }, { virtualAgent: { desired: { not: "deleted" } } }],
      ...(virtualAgentId === undefined ? {} : { virtualAgentId })
    },
    select: { ...SELECT, agent: { select: { status: true } } },
    orderBy: [{ lastActiveAt: "desc" }, { id: "asc" }],
    take: limit
  });
  return rows.map(({ agent, ...row }) => ({ ...toRow(row), agentStatus: agent?.status ?? "offline" }));
}

/**
 * Whether any of the owner's conversations is a session on their own computer.
 *
 * A fact about the whole list rather than about any one row, and so its own read: it is what decides whether a chat
 * running on a pod is marked as one at all, since a cloud beside every row of a list that holds nothing else tells
 * nobody anything. Asked here, by both the sidebar's list and its search, so the two cannot answer it differently
 * for the same person — and asked of every one of their conversations rather than of the page the sidebar loaded,
 * which is capped and so could miss the only local chat they have.
 *
 * Only a chat the list would show counts (`first_content_at`): one left out for having nothing in it would otherwise put a
 * mark against every pod chat for a reason the person cannot see.
 *
 * No `virtual_agent` filter, unlike `listConversations`: these rows have no related virtual agent to be deleted.
 */
export async function hasLocalConversation(db: Database, ownerOid: string): Promise<boolean> {
  return (
    (await db.assistantConversation.findFirst({ where: { ownerOid, virtualAgentId: null, firstContentAt: { not: null } }, select: { id: true } })) !== null
  );
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
 * Any conversation of the owner's, with or without a pod, however old. `state = 'stored'` rather than any unclaimed
 * upload, because a half-uploaded file cannot be sent and there is nothing to hand back.
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

/**
 * Creates the conversation's agent: offline, the assistant's, under a session id the pod will start a session as.
 *
 * Refused with a 409 for a conversation with no pod, which never gets an agent from the hub, and when its
 * `virtual_agent` row has gone, since the agent's name and its `virtual_agent_id` are read off it.
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
    throw new HttpError(409, "open the CFT Workspace first, so it can be set up");
  }
  const title = messageTitle(request.title ?? "");
  return await prisma.$transaction(async (tx) => {
    const created = await tx.assistantConversation.create({
      data: { ownerOid, virtualAgentId: assistant.id, product, title },
      select: SELECT
    });
    const agentId = await createConversationAgent(tx, created);
    // Not announced. Nothing is in it, so no list shows it, and the only other listener, the pod's sessions stream,
    // reads a wake from the event, which this conversation has none of until one is asked for.
    return { ...toRow(created), agentId };
  });
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
 * A conversation with no pod is detached instead (`detachLocalSessions`, as the person removing it), then deleted,
 * taking its document, exports, shares and fork offers with it, and no message is touched. Its agent is a session
 * running on the person's own laptop and one of their ordinary sessions — on the hub roster, taggable in anyone's
 * post, holding the transcript it uploaded, its topic subscriptions, its questions and a direct thread that includes
 * board messages with colleagues that have nothing to do with this chat. Deleting the conversation row without
 * clearing the column first would cascade through all of that. Removing a chat is about the chat; the session on the
 * laptop is left exactly as it was, except that it is never given a chat again, and a new session is a new agent that
 * gets a chat of its own.
 *
 * All in one transaction holding the conversation's row lock, which the local sweep also takes, skipping a row it
 * cannot lock. The sessions are read before the lock is waited on: if the sweep held it and collected the chat, the
 * row is gone by the time the lock is granted, and those sessions — detached by the sweep, and so due a fresh chat —
 * are marked here so the person's removal still holds. A chat already gone before the person acted has no sessions
 * left to read and is not found.
 */
export async function deleteConversation(prisma: PrismaClient, ownerOid: string, id: string): Promise<void> {
  if (!isUuid(id)) {
    throw new ConversationNotFound();
  }
  await prisma.$transaction(async (tx) => {
    const sessions = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM agent WHERE assistant_conversation_id = ${id}::uuid AND owner_oid = ${ownerOid} AND virtual_agent_id IS NULL
    `;
    const [locked] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM assistant_conversation WHERE id = ${id}::uuid FOR UPDATE`;
    if (locked === undefined && sessions.length > 0) {
      await markChatRemoved(
        tx,
        sessions.map((session) => session.id)
      );
      return;
    }
    const conversation = await findConversation(tx, ownerOid, id);
    if (conversation === undefined) {
      throw new ConversationNotFound();
    }
    if (hasPod(conversation)) {
      await tx.$executeRaw`
        DELETE FROM message
         WHERE kind = 'direct'
           AND (target_agent_id IN (SELECT id FROM agent WHERE assistant_conversation_id = ${id}::uuid)
                OR author_agent_id IN (SELECT id FROM agent WHERE assistant_conversation_id = ${id}::uuid))
      `;
    } else {
      await detachLocalSessions(tx, id, { removedByPerson: true });
    }
    await tx.assistantConversation.delete({ where: { id } });
    await announce(tx, conversation);
  });
}

/** The conversation an agent is a session of, for the agent API's artefact routes. */
export async function conversationOfAgent(db: Database, agentId: string): Promise<ConversationRow | undefined> {
  const row = await db.agent.findUnique({ where: { id: agentId }, select: { assistantConversation: { select: SELECT } } });
  return row?.assistantConversation === null || row?.assistantConversation === undefined ? undefined : toRow(row.assistantConversation);
}

/** `conversationOfAgent`, or the 404 the agent API answers for an agent that is no conversation's. */
export async function requireConversationOfAgent(db: Database, agentId: string): Promise<ConversationRow> {
  const conversation = await conversationOfAgent(db, agentId);
  if (conversation === undefined) {
    throw new HttpError(404, "that agent is not an assistant conversation's");
  }
  return conversation;
}
