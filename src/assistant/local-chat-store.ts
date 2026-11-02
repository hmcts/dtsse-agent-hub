import { nameSourceOf } from "../agents/name-source.ts";
import { clientPrisma } from "../store/client-namespace.ts";
import type { Prisma } from "../store/generated/client.js";
import type { Database } from "../store/prisma.ts";
import { announce, type ConversationRow, SELECT, toRow } from "./conversation-row.ts";
import { DEFAULT_PRODUCT } from "./products.ts";
import { firstPromptTitle, localTitle, PROMPT_CANDIDATES, type TitleSource } from "./titles.ts";

/**
 * The chats of Claude Code sessions on a person's own computer: linked to the session's own agent when it registers or
 * heartbeats, named from what the session reports and what the person types, and detached rather than deleted with
 * the conversation, since the session itself is one of the person's ordinary agents.
 */

/**
 * Creates the conversation of a local session: no pod, the session's own agent as its current one, and the default
 * product.
 *
 * A sibling of `createConversation` rather than a branch of it, because the two share none of their steps. That one
 * needs the person's assistant and creates an agent for the pod to start a session as; here the agent is the session
 * that is already running on somebody's laptop, so there is no pod to find and nothing to create.
 *
 * Not announced: the sidebar is the only listener for a chat with no pod, and it lists the chat only once something
 * is in it, which this has not.
 */
async function createLocalConversation(db: Database, session: { ownerOid: string; agentId: string; title: string | null }): Promise<ConversationRow> {
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
  return toRow(created);
}

/**
 * Whether an agent row, as `alias`, is a session on somebody's own computer that should be given a chat: nobody's
 * pod, in no conversation, and not one whose chat the person removed (`chat_removed_at`, see `deleteConversation`).
 * `linkLocalSession` holds every link to it; the registration and the heartbeat read it to skip that call when it
 * could do nothing. `alias` is always a literal of the caller's.
 */
export function needsLocalChatSql(alias: string): Prisma.Sql {
  const { raw, sql } = clientPrisma();
  const agent = raw(alias);
  return sql`(${agent}.virtual_agent_id IS NULL AND ${agent}.assistant_conversation_id IS NULL AND ${agent}.chat_removed_at IS NULL)`;
}

/**
 * The chat an agent row, as `alias`, is the session of when it is a session on somebody's own computer, as text; null
 * for a pod's agent, which has a virtual agent, and for a session in no chat. What an `agent_status` NOTIFY names as
 * its `local_conversation_id`, so every site that announces a status says the same about the same row. `alias` is
 * always a literal of the caller's.
 */
export function localConversationSql(alias: string): Prisma.Sql {
  const { raw, sql } = clientPrisma();
  const agent = raw(alias);
  return sql`(CASE WHEN ${agent}.virtual_agent_id IS NULL THEN ${agent}.assistant_conversation_id::text END)`;
}

/**
 * A laptop session's conversation, created and linked to the session's own agent; called inside the registration's
 * or the heartbeat's transaction. Answers the conversation, or `undefined` when the agent needs none
 * (`needsLocalChatSql`): already in one, or a session whose chat the person removed, which is never given another.
 *
 * Named after `linkSession` and deliberately not it: that one sets `sessionState` to `live` and clears the wake,
 * which is a pod's supervisor reporting that it has started the session the hub asked for. A laptop has no
 * supervisor and the hub asked for nothing, so neither field means anything here and both stay null.
 *
 * The agent's row is locked and checked before anything is created, so nothing is made that cannot be linked, and
 * the link then holds for the rest of the transaction. The link is a column of its own rather than of the
 * registration's upsert, whose `SET` list leaves `assistant_conversation_id` and `chat_removed_at` alone — that is what
 * lets the link, and a removal, survive a re-registration, which sends no conversation of any kind.
 *
 * The chat starts empty, whatever the session has said before, and nothing announces it: only content arriving after
 * the link puts it in the sidebar (`announceFirstContent`). A session whose empty chat the local sweep collected is
 * linked a new one on its next heartbeat, which stays out of the list until the session next says something.
 */
export async function linkLocalSession(db: Database, session: { ownerOid: string; agentId: string; name: string }): Promise<ConversationRow | undefined> {
  const [needs] = await db.$queryRaw<{ id: string }[]>`
    SELECT a.id::text AS id FROM agent a WHERE a.id = ${session.agentId}::uuid AND ${needsLocalChatSql("a")} FOR UPDATE
  `;
  if (needs === undefined) {
    return undefined;
  }
  const created = await createLocalConversation(db, { ownerOid: session.ownerOid, agentId: session.agentId, title: localTitle(session.name) });
  await db.$executeRaw`UPDATE agent SET assistant_conversation_id = ${created.id}::uuid WHERE id = ${session.agentId}::uuid`;
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
 * The upload calls it for every batch carrying a prompt that could name a chat, whatever session sent it, so every
 * condition is checked here: the agent's conversation is read in this transaction, and a board session with no chat,
 * a chat on a pod, or one the person renamed in the hub ends the call after that one read.
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
 * could still claim the title — after that a titled chat costs one indexed read per prompt-carrying upload and
 * nothing else.
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
 * Clears the cascading link of a conversation with no pod from every agent in it, so the row can be deleted without
 * taking the sessions' transcripts, deliveries, subscriptions and messages with it. Called in the transaction that
 * deletes the row.
 *
 * `removedByPerson` also sets `chat_removed_at`, so the session is never linked another chat (`needsLocalChatSql`).
 * The local sweep detaches without it: the person removed nothing, and a session that comes back is given a chat
 * again.
 */
export async function detachLocalSessions(db: Database, conversationId: string, options: { removedByPerson: boolean }): Promise<void> {
  await db.$executeRaw`
    UPDATE agent
       SET assistant_conversation_id = NULL,
           chat_removed_at = CASE WHEN ${options.removedByPerson}::boolean THEN now() ELSE chat_removed_at END
     WHERE assistant_conversation_id = ${conversationId}::uuid
  `;
}

/** Marks sessions the local sweep detached from a chat the person removed in the same moment; see `deleteConversation`. */
export async function markChatRemoved(db: Database, agentIds: readonly string[]): Promise<void> {
  await db.$executeRaw`
    UPDATE agent SET chat_removed_at = now()
     WHERE id = ANY(${[...agentIds]}::uuid[]) AND assistant_conversation_id IS NULL AND virtual_agent_id IS NULL
  `;
}
