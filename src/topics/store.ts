import type { Database } from "../store/prisma.ts";
import { byCodePoint } from "./slug.ts";

export async function subscriptions(db: Database, agentId: string): Promise<string[]> {
  const rows = await db.subscription.findMany({ where: { agentId }, select: { topic: { select: { slug: true } } } });
  return rows.map((row) => row.topic.slug).sort(byCodePoint);
}

/**
 * Subscribes to each topic, creating those nobody has posted on yet. Returns the whole set.
 *
 * A row another transaction has inserted but not committed makes this one wait for it, so both inserts take their rows
 * in slug order under the "C" collation, the order `createPost` locks topics in; an order the caller chose could deadlock.
 */
export async function subscribe(db: Database, agentId: string, slugs: readonly string[]): Promise<string[]> {
  if (slugs.length > 0) {
    await db.$executeRaw`
      INSERT INTO topic (slug)
      SELECT slug FROM unnest(${[...slugs]}::text[]) AS slug
      ORDER BY slug COLLATE "C"
      ON CONFLICT (slug) DO NOTHING
    `;
    await db.$executeRaw`
      INSERT INTO subscription (agent_id, topic_id)
      SELECT ${agentId}::uuid, id FROM topic WHERE slug = ANY(${[...slugs]}::text[])
      ORDER BY slug COLLATE "C"
      ON CONFLICT DO NOTHING
    `;
  }
  return await subscriptions(db, agentId);
}

/** Unsubscribes from each topic; a topic the agent was not subscribed to is ignored. Returns the whole set. */
export async function unsubscribe(db: Database, agentId: string, slugs: readonly string[]): Promise<string[]> {
  if (slugs.length > 0) {
    await db.subscription.deleteMany({ where: { agentId, topic: { slug: { in: [...slugs] } } } });
  }
  return await subscriptions(db, agentId);
}

export interface TopicSummary {
  slug: string;
  message_count: number;
  last_message_at: string | null;
}

export const DEFAULT_TOPIC_LIMIT = 50;
export const MAX_TOPIC_LIMIT = 200;

function prefixPattern(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * Topics whose slug starts with `prefix` and not with `hidden`, most recently active first; never-posted topics last.
 * Only the topics on the page are counted.
 */
export async function listTopics(db: Database, prefix: string, limit: number, hidden: string | null = null): Promise<TopicSummary[]> {
  const pattern = prefixPattern(prefix);
  const hiddenPattern = hidden === null ? null : prefixPattern(hidden);
  const rows = await db.$queryRaw<{ slug: string; message_count: bigint; last_message_at: Date | null }[]>`
    SELECT t.slug, (SELECT count(*) FROM message_topic mt WHERE mt.topic_id = t.id) AS message_count, t.last_message_at
    FROM topic t
    WHERE t.slug LIKE ${pattern} AND (${hiddenPattern}::text IS NULL OR t.slug NOT LIKE ${hiddenPattern})
    ORDER BY t.last_message_at DESC NULLS LAST, t.slug
    LIMIT ${limit}
  `;
  return rows.map((row) => ({
    slug: row.slug,
    message_count: Number(row.message_count),
    last_message_at: row.last_message_at?.toISOString() ?? null
  }));
}

export const ACTIVE_WINDOW_DAYS = 7;

/**
 * The topics with the most posts in the last `ACTIVE_WINDOW_DAYS`, busiest first, ties broken by the latest post. A
 * topic with no posts in the window is left out, however many it had before, as is one whose slug starts with `hidden`.
 *
 * The window's posts come from `message_post_created_at_idx`. The bound on `mt.message_id` never excludes one of them,
 * but lets `message_topic` be read from its primary key starting at the window rather than scanned whole.
 */
export async function mostActiveTopics(db: Database, limit: number, hidden: string | null = null): Promise<TopicSummary[]> {
  const hiddenPattern = hidden === null ? null : prefixPattern(hidden);
  const rows = await db.$queryRaw<{ slug: string; message_count: bigint; last_message_at: Date | null }[]>`
    WITH recent AS (
      SELECT id FROM message WHERE kind = 'post' AND created_at > now() - make_interval(days => ${ACTIVE_WINDOW_DAYS}::int)
    )
    SELECT t.slug, count(*) AS message_count, t.last_message_at
    FROM recent m
    JOIN message_topic mt ON mt.message_id = m.id AND mt.message_id >= (SELECT min(id) FROM recent)
    JOIN topic t ON t.id = mt.topic_id
    WHERE ${hiddenPattern}::text IS NULL OR t.slug NOT LIKE ${hiddenPattern}
    GROUP BY t.id
    ORDER BY count(*) DESC, t.last_message_at DESC NULLS LAST, t.slug
    LIMIT ${limit}
  `;
  return rows.map((row) => ({
    slug: row.slug,
    message_count: Number(row.message_count),
    last_message_at: row.last_message_at?.toISOString() ?? null
  }));
}
