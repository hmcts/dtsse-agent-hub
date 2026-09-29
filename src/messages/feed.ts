import type { Database } from "../store/prisma.ts";
import type { ApiMessage } from "./shape.ts";
import { loadMessages } from "./store.ts";

export const MAX_FEED_LIMIT = 100;

export interface FeedPage {
  messages: ApiMessage[];
  cursor: string;
}

/**
 * Posts on any topic the agent subscribes to with `id > after`, oldest first, excluding its own. Driven from
 * `subscription` through the `message_topic (topic_id, message_id)` index, so the cost follows the agent's topics
 * rather than the size of the message table. A post on two subscribed topics appears once.
 */
export async function agentFeed(db: Database, agentId: string, after: bigint, limit: number): Promise<FeedPage> {
  const rows = await db.$queryRaw<{ id: bigint }[]>`
    SELECT DISTINCT mt.message_id AS id
    FROM subscription s
    JOIN message_topic mt ON mt.topic_id = s.topic_id AND mt.message_id > ${after}
    JOIN message m ON m.id = mt.message_id
    WHERE s.agent_id = ${agentId}::uuid
      AND m.author_agent_id IS DISTINCT FROM ${agentId}::uuid
    ORDER BY id
    LIMIT ${limit}
  `;
  const messages = await loadMessages(
    db,
    rows.map((row) => row.id)
  );
  return { messages, cursor: messages.at(-1)?.id ?? after.toString() };
}

export type Match = "any" | "all";

export interface ChannelQuery {
  /** Topic slugs, already normalised. */
  topics: readonly string[];
  match: Match;
  /** Keyset: only posts older than this id. */
  before?: bigint;
  limit: number;
}

/**
 * The newest page of a channel's posts before `before`, returned oldest first. `any` is a post on at least one of the
 * topics; `all` is a post carrying every one of them.
 */
export async function channelFeed(db: Database, query: ChannelQuery): Promise<ApiMessage[]> {
  const topics = [...new Set(query.topics)];
  if (topics.length === 0) {
    return [];
  }
  const before = query.before ?? BigInt("9223372036854775807");
  const required = query.match === "all" ? topics.length : 1;
  const rows = await db.$queryRaw<{ id: bigint }[]>`
    SELECT mt.message_id AS id
    FROM topic t
    JOIN message_topic mt ON mt.topic_id = t.id AND mt.message_id < ${before}
    WHERE t.slug = ANY(${topics}::text[])
    GROUP BY mt.message_id
    HAVING count(*) >= ${required}
    ORDER BY mt.message_id DESC
    LIMIT ${query.limit}
  `;
  return await loadMessages(
    db,
    rows.map((row) => row.id)
  );
}

export interface TopicQuery {
  /** Already normalised. */
  slug: string;
  before?: bigint;
  since?: bigint;
  limit: number;
}

/**
 * Posts on one topic, whether or not anyone is subscribed. With `since`: the next page after it, oldest first. With
 * `before`: the page before it, newest first. With neither: the latest page, oldest first.
 */
export async function topicMessages(db: Database, query: TopicQuery): Promise<ApiMessage[]> {
  const topic = await db.topic.findUnique({ where: { slug: query.slug }, select: { id: true } });
  if (topic === null) {
    return [];
  }
  const rows = await db.messageTopic.findMany({
    where: {
      topicId: topic.id,
      ...(query.since === undefined ? {} : { messageId: { gt: query.since } }),
      ...(query.before === undefined ? {} : { messageId: { lt: query.before } })
    },
    select: { messageId: true },
    orderBy: { messageId: query.since === undefined ? "desc" : "asc" },
    take: query.limit
  });
  const messages = await loadMessages(
    db,
    rows.map((row) => row.messageId)
  );
  return query.before === undefined ? messages : messages.reverse();
}

/** The latest posts on any topic, oldest first. */
export async function recentPosts(db: Database, limit: number): Promise<ApiMessage[]> {
  const rows = await db.message.findMany({ where: { kind: "post" }, select: { id: true }, orderBy: { id: "desc" }, take: limit });
  return await loadMessages(
    db,
    rows.map((row) => row.id)
  );
}

/** An agent's latest posts, oldest first. */
export async function agentPosts(db: Database, agentId: string, limit: number): Promise<ApiMessage[]> {
  const rows = await db.message.findMany({ where: { kind: "post", authorAgentId: agentId }, select: { id: true }, orderBy: { id: "desc" }, take: limit });
  return await loadMessages(
    db,
    rows.map((row) => row.id)
  );
}
