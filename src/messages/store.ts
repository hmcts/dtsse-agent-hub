import { notify } from "../realtime/notify.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { type ApiMessage, toApiMessage } from "./shape.ts";

export const MESSAGE_SELECT = {
  id: true,
  kind: true,
  title: true,
  body: true,
  inReplyTo: true,
  targetAgentId: true,
  createdAt: true,
  authorAgent: { select: { id: true, name: true } },
  author: { select: { name: true, email: true } },
  topics: { select: { topic: { select: { slug: true } } } }
} as const;

/** The messages with these ids, oldest first. Ids with no message are skipped. */
export async function loadMessages(db: Database, ids: readonly bigint[]): Promise<ApiMessage[]> {
  if (ids.length === 0) {
    return [];
  }
  const rows = await db.message.findMany({ where: { id: { in: [...ids] } }, select: MESSAGE_SELECT, orderBy: { id: "asc" } });
  return rows.map(toApiMessage);
}

export async function loadMessage(db: Database, id: bigint): Promise<ApiMessage | undefined> {
  const [message] = await loadMessages(db, [id]);
  return message;
}

export interface Author {
  oid: string;
  agentId: string | null;
}

export interface NewPost {
  author: Author;
  /** Already normalised by `postTopics`. */
  topics: readonly string[];
  title: string | null;
  body: string;
  inReplyTo: bigint | null;
}

/**
 * Writes a post, creating any topic it names for the first time and stamping each topic's `last_message_at`. The
 * topic-count trigger checks the count at commit, and the NOTIFY is delivered only on commit.
 */
export async function createPost(prisma: PrismaClient, post: NewPost): Promise<ApiMessage> {
  const id = await prisma.$transaction(async (tx) => {
    const topics = await tx.$queryRaw<{ id: number }[]>`
      INSERT INTO topic (slug, last_message_at)
      SELECT unnest(${[...post.topics]}::text[]), now()
      ON CONFLICT (slug) DO UPDATE SET last_message_at = EXCLUDED.last_message_at
      RETURNING id
    `;
    const message = await tx.message.create({
      data: {
        kind: "post",
        authorOid: post.author.oid,
        authorAgentId: post.author.agentId,
        title: post.title,
        body: post.body,
        inReplyTo: post.inReplyTo
      },
      select: { id: true }
    });
    await tx.messageTopic.createMany({ data: topics.map((topic) => ({ messageId: message.id, topicId: topic.id })) });
    await notify(tx, { type: "post", message_id: message.id.toString() });
    return message.id;
  });
  return (await loadMessage(prisma, id))!;
}

export interface NewDirect {
  author: Author;
  /** `null` for an agent's reply to a person, which lands in the replying agent's own thread. */
  targetAgentId: string | null;
  inReplyTo: bigint | null;
  body: string;
}

/** Writes a direct message and, when it targets an agent, the queued delivery its stream will send. */
export async function createDirect(prisma: PrismaClient, direct: NewDirect): Promise<ApiMessage> {
  const id = await prisma.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: {
        kind: "direct",
        authorOid: direct.author.oid,
        authorAgentId: direct.author.agentId,
        targetAgentId: direct.targetAgentId,
        inReplyTo: direct.inReplyTo,
        body: direct.body
      },
      select: { id: true }
    });
    if (direct.targetAgentId !== null) {
      await tx.delivery.create({ data: { messageId: message.id, agentId: direct.targetAgentId } });
    }
    await notify(tx, {
      type: "direct",
      message_id: message.id.toString(),
      target_agent_id: direct.targetAgentId,
      author_agent_id: direct.author.agentId
    });
    return message.id;
  });
  return (await loadMessage(prisma, id))!;
}

/** Every direct message still queued for the agent, oldest first. */
export async function queuedDeliveries(db: Database, agentId: string): Promise<ApiMessage[]> {
  const rows = await db.delivery.findMany({
    where: { agentId, state: "queued" },
    select: { messageId: true },
    orderBy: { messageId: "asc" }
  });
  return await loadMessages(
    db,
    rows.map((row) => row.messageId)
  );
}

/** The message, if it is still queued for the agent. */
export async function queuedDelivery(db: Database, agentId: string, messageId: bigint): Promise<ApiMessage | undefined> {
  const delivery = await db.delivery.findUnique({ where: { messageId_agentId: { messageId, agentId } }, select: { state: true } });
  return delivery?.state === "queued" ? await loadMessage(db, messageId) : undefined;
}

/**
 * Marks a delivery delivered, and announces it so a UI thread showing the message updates. `false` when the agent
 * has no delivery for that message. Acking twice is harmless and announces nothing the second time.
 */
export async function ackDelivery(prisma: PrismaClient, agentId: string, messageId: bigint): Promise<boolean> {
  const acked = await prisma.$transaction(async (tx) => {
    const { count } = await tx.delivery.updateMany({
      where: { messageId, agentId, state: "queued" },
      data: { state: "delivered", deliveredAt: new Date() }
    });
    if (count > 0) {
      await notify(tx, { type: "delivery", message_id: messageId.toString(), agent_id: agentId, state: "delivered" });
    }
    return count > 0;
  });
  return acked || (await prisma.delivery.count({ where: { messageId, agentId } })) > 0;
}

/**
 * Expires up to `limit` deliveries still queued for agents that have been offline for longer than
 * `offlineForSeconds`, oldest first, and announces each so a UI thread showing the message updates. Call it inside
 * a transaction, so the NOTIFYs go out only if the expiry commits.
 *
 * An offline agent's heartbeat revives it, so the cut-off is measured from the later of its last heartbeat and its
 * end. `SKIP LOCKED` leaves a delivery being acked to the ack. Returns how many expired.
 */
export async function expireDeliveries(db: Database, offlineForSeconds: number, limit: number): Promise<number> {
  const expired = await db.$queryRaw<{ message_id: string; agent_id: string }[]>`
    WITH due AS (
      SELECT d.message_id, d.agent_id
        FROM delivery d
        JOIN agent a ON a.id = d.agent_id
       WHERE d.state = 'queued'
         AND a.status = 'offline'
         AND GREATEST(a.last_heartbeat_at, a.ended_at) < now() - make_interval(secs => ${offlineForSeconds}::double precision)
       ORDER BY d.message_id
       LIMIT ${limit}::int
         FOR UPDATE OF d SKIP LOCKED
    )
    UPDATE delivery SET state = 'expired'
      FROM due
     WHERE delivery.message_id = due.message_id AND delivery.agent_id = due.agent_id
    RETURNING delivery.message_id::text AS message_id, delivery.agent_id::text AS agent_id
  `;
  for (const delivery of expired) {
    await notify(db, { type: "delivery", message_id: delivery.message_id, agent_id: delivery.agent_id, state: "expired" });
  }
  return expired.length;
}
