import type { Database } from "../store/prisma.ts";

function byCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

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

/** Topics whose slug starts with `prefix`, most recently active first; never-posted topics last. */
export async function listTopics(db: Database, prefix: string, limit: number): Promise<TopicSummary[]> {
  const pattern = `${prefix.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  const rows = await db.$queryRaw<{ slug: string; message_count: bigint; last_message_at: Date | null }[]>`
    SELECT t.slug, count(mt.message_id) AS message_count, t.last_message_at
    FROM topic t
    LEFT JOIN message_topic mt ON mt.topic_id = t.id
    WHERE t.slug LIKE ${pattern}
    GROUP BY t.id
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
 * topic with no posts in the window is left out, however many it had before.
 */
export async function mostActiveTopics(db: Database, limit: number): Promise<TopicSummary[]> {
  const rows = await db.$queryRaw<{ slug: string; message_count: bigint; last_message_at: Date | null }[]>`
    SELECT t.slug, count(*) AS message_count, t.last_message_at
    FROM topic t
    JOIN message_topic mt ON mt.topic_id = t.id
    JOIN message m ON m.id = mt.message_id
    WHERE m.kind = 'post' AND m.created_at > now() - make_interval(days => ${ACTIVE_WINDOW_DAYS}::int)
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
