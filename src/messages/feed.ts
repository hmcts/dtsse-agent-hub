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

/** The posts a view is over: a set of topic slugs, or every post on any topic. */
export type PostScope = readonly string[] | "everything";

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
 *
 * Both walk the `message_topic (topic_id, message_id)` index down from `before` and stop once the page is full, so
 * the cost follows the page rather than how many posts the topics have ever had.
 */
export async function channelFeed(db: Database, query: ChannelQuery): Promise<ApiMessage[]> {
  const slugs = [...new Set(query.topics)];
  if (slugs.length === 0) {
    return [];
  }
  const found = await db.topic.findMany({ where: { slug: { in: slugs } }, select: { id: true } });
  const topicIds = found.map((topic) => topic.id);
  if (topicIds.length === 0 || (query.match === "all" && topicIds.length < slugs.length)) {
    return [];
  }
  const before = query.before ?? BigInt("9223372036854775807");
  const rows = query.match === "all" ? await pageOnAll(db, topicIds, before, query.limit) : await pageOnAny(db, topicIds, before, query.limit);
  return await loadMessages(
    db,
    rows.map((row) => row.id)
  );
}

/** The page is among each topic's own newest `limit` posts before `before`. */
async function pageOnAny(db: Database, topicIds: number[], before: bigint, limit: number): Promise<{ id: bigint }[]> {
  return await db.$queryRaw<{ id: bigint }[]>`
    SELECT DISTINCT newest.message_id AS id
    FROM unnest(${topicIds}::int[]) AS wanted (topic_id)
    CROSS JOIN LATERAL (
      SELECT mt.message_id FROM message_topic mt
      WHERE mt.topic_id = wanted.topic_id AND mt.message_id < ${before}
      ORDER BY mt.message_id DESC
      LIMIT ${limit}
    ) newest
    ORDER BY id DESC
    LIMIT ${limit}
  `;
}

/**
 * A leapfrog intersection, newest first. Each step reads every topic's newest post at or below `bound`. When they
 * agree, that post carries every topic and the walk goes on below it; otherwise the lowest of them is the highest id
 * that could still be on all of them, and the walk goes on from there. It ends when any topic runs out, so it takes
 * at most about two steps per post on the quietest topic, and the `LIMIT` stops it as soon as the page is full.
 */
async function pageOnAll(db: Database, topicIds: number[], before: bigint, limit: number): Promise<{ id: bigint }[]> {
  return await db.$queryRaw<{ id: bigint }[]>`
    WITH RECURSIVE walk (bound, hit) AS (
      SELECT ${before}::bigint - 1, NULL::bigint
      UNION ALL
      SELECT CASE WHEN step.low = step.high THEN step.low - 1 ELSE step.low END,
             CASE WHEN step.low = step.high THEN step.low END
      FROM walk
      CROSS JOIN LATERAL (
        SELECT min(head.message_id) AS low, max(head.message_id) AS high, count(head.message_id) AS heads
        FROM unnest(${topicIds}::int[]) AS wanted (topic_id)
        CROSS JOIN LATERAL (
          SELECT max(mt.message_id) AS message_id FROM message_topic mt
          WHERE mt.topic_id = wanted.topic_id AND mt.message_id <= walk.bound
        ) head
      ) step
      WHERE step.heads = ${topicIds.length}::int
    )
    SELECT hit AS id FROM walk WHERE hit IS NOT NULL LIMIT ${limit}
  `;
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

/**
 * The newest page of posts on any topic before `before`, returned oldest first. Walks `message_post_id_idx` down
 * from `before`, so the directs between posts are never read.
 */
export async function recentPosts(db: Database, query: { before?: bigint; limit: number }): Promise<ApiMessage[]> {
  const rows = await db.message.findMany({
    where: { kind: "post", ...(query.before === undefined ? {} : { id: { lt: query.before } }) },
    select: { id: true },
    orderBy: { id: "desc" },
    take: query.limit
  });
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
