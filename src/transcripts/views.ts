import { type AgentRef, canViewTranscript, type Grant } from "../access/rules.ts";
import { agentThread } from "../messages/direct-thread.ts";
import type { Database } from "../store/prisma.ts";
import { type ConversationPage, mergeEntries, type TranscriptEntryView } from "./conversation.ts";
import type { TranscriptContent, TranscriptRole } from "./schema.ts";

export const CONVERSATION_PAGE_SIZE = 100;

/** Entries one live top-up reads; a client further behind than this reads again. */
export const TOP_UP_LIMIT = 200;

export type ConversationCursor = { before: bigint } | { after: bigint } | Record<string, never>;

const SELECT = {
  id: true,
  entryKey: true,
  sessionId: true,
  role: true,
  content: true,
  truncated: true,
  redacted: true,
  messageId: true,
  occurredAt: true
} as const;

type Row = {
  id: bigint;
  entryKey: string;
  sessionId: string;
  role: TranscriptRole;
  content: unknown;
  truncated: boolean;
  redacted: boolean;
  messageId: bigint | null;
  occurredAt: Date;
};

function toView(row: Row): TranscriptEntryView {
  return {
    id: row.id.toString(),
    key: row.entryKey,
    session_id: row.sessionId,
    role: row.role,
    // Validated against its role's shape before it was stored.
    content: row.content as TranscriptContent,
    truncated: row.truncated,
    redacted: row.redacted,
    message_id: row.messageId?.toString() ?? null,
    occurred_at: row.occurredAt.toISOString()
  };
}

const EMPTY: ConversationPage = { messages: [], entries: [], olderBefore: null, lastId: null, more: false };

/**
 * A page of the agent's conversation as the viewer may see it: its transcript with the direct messages they may read.
 *
 * - No cursor: the latest entries, the messages since the oldest of them, and the transcript's newest id.
 * - `before`: the entries before that one in time, and the messages between the oldest of them and it. Once the
 *   transcript's start is reached, every earlier message is included too, up to the thread's limit.
 * - `after`: the entries stored since that id, whenever they occurred, for live top-ups. Messages arrive on the
 *   stream, so none are read.
 *
 * A viewer who may not read the transcript gets the thread alone.
 */
export async function agentConversation(
  db: Database,
  viewerOid: string,
  agent: AgentRef,
  grants: readonly Grant[],
  cursor: ConversationCursor = {}
): Promise<ConversationPage> {
  if (!canViewTranscript(viewerOid, agent, grants)) {
    return "after" in cursor || "before" in cursor ? EMPTY : { ...EMPTY, messages: await agentThread(db, viewerOid, agent.id, grants) };
  }

  if ("after" in cursor) {
    const rows = await db.transcriptEntry.findMany({
      where: { agentId: agent.id, id: { gt: cursor.after } },
      select: SELECT,
      orderBy: { id: "asc" },
      take: TOP_UP_LIMIT + 1
    });
    const kept = rows.slice(0, TOP_UP_LIMIT);
    const entries = mergeEntries([], kept.map(toView));
    return { ...EMPTY, entries, lastId: kept.at(-1)?.id.toString() ?? cursor.after.toString(), more: rows.length > TOP_UP_LIMIT };
  }

  let anchor: { id: bigint; occurredAt: Date } | null = null;
  if ("before" in cursor) {
    anchor = await db.transcriptEntry.findFirst({ where: { id: cursor.before, agentId: agent.id }, select: { id: true, occurredAt: true } });
    if (anchor === null) {
      return EMPTY;
    }
  }

  const [rows, newest] = await Promise.all([
    db.transcriptEntry.findMany({
      where: {
        agentId: agent.id,
        ...(anchor === null ? {} : { OR: [{ occurredAt: { lt: anchor.occurredAt } }, { occurredAt: anchor.occurredAt, id: { lt: anchor.id } }] })
      },
      select: SELECT,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: CONVERSATION_PAGE_SIZE + 1
    }),
    anchor === null ? db.transcriptEntry.aggregate({ where: { agentId: agent.id }, _max: { id: true } }) : undefined
  ]);
  const kept = rows.slice(0, CONVERSATION_PAGE_SIZE).reverse();
  const oldest = rows.length > CONVERSATION_PAGE_SIZE ? kept[0] : undefined;
  const messages = await agentThread(db, viewerOid, agent.id, grants, {
    ...(oldest === undefined ? {} : { since: oldest.occurredAt }),
    ...(anchor === null ? {} : { until: anchor.occurredAt })
  });
  return {
    messages,
    entries: kept.map(toView),
    olderBefore: oldest?.id.toString() ?? null,
    lastId: newest?._max.id?.toString() ?? null,
    more: false
  };
}
