import { canReadMessage, type Grant, type MessageRef } from "../access/rules.ts";
import type { Database } from "../store/prisma.ts";
import { type ApiMessage, toApiMessage } from "./shape.ts";
import { MESSAGE_SELECT } from "./store.ts";

/**
 * An agent's direct-message thread as the UI shows it: what it received, what it sent, and the replies it wrote to
 * people (which have no target agent), each with the state of its delivery to the target.
 */

export type DeliveryView = "queued" | "delivered" | "expired";

export interface ThreadMessage extends ApiMessage {
  /** `null` for a message with no target agent: an agent's reply into its own thread has nothing to deliver. */
  delivery: DeliveryView | null;
}

export interface LoadedThreadMessage {
  message: ThreadMessage;
  ref: MessageRef;
}

const SELECT = {
  ...MESSAGE_SELECT,
  authorOid: true,
  authorAgent: { select: { id: true, name: true, ownerOid: true } },
  targetAgent: { select: { id: true, ownerOid: true } },
  parent: { select: { authorOid: true } },
  deliveries: { select: { agentId: true, state: true } }
} as const;

type Row = {
  id: bigint;
  kind: "post" | "direct";
  title: string | null;
  body: string;
  inReplyTo: bigint | null;
  targetAgentId: string | null;
  createdAt: Date;
  authorOid: string;
  authorAgent: { id: string; name: string; ownerOid: string } | null;
  author: { name: string; email: string | null };
  topics: { topic: { slug: string } }[];
  targetAgent: { id: string; ownerOid: string } | null;
  parent: { authorOid: string } | null;
  deliveries: { agentId: string; state: DeliveryView }[];
};

function toLoaded(row: Row): LoadedThreadMessage {
  const delivery = row.deliveries.find((entry) => entry.agentId === row.targetAgentId)?.state ?? null;
  return {
    message: { ...toApiMessage(row), delivery },
    ref: {
      kind: row.kind,
      authorOid: row.authorOid,
      authorAgent: row.authorAgent === null ? null : { id: row.authorAgent.id, ownerOid: row.authorAgent.ownerOid },
      targetAgent: row.targetAgent,
      parentAuthorOid: row.parent?.authorOid ?? null
    }
  };
}

export async function loadThreadMessage(db: Database, id: bigint): Promise<LoadedThreadMessage | undefined> {
  const row = await db.message.findUnique({ where: { id }, select: SELECT });
  return row === null ? undefined : toLoaded(row);
}

/** Whether a direct message belongs in `agentId`'s thread. */
export function inThread(agentId: string, message: { targetAgentId: string | null; authorAgentId: string | null }): boolean {
  return message.targetAgentId === agentId || message.authorAgentId === agentId;
}

export const THREAD_LIMIT = 100;

/** The latest direct messages in the agent's thread that the viewer may read, oldest first. */
export async function agentThread(db: Database, viewerOid: string, agentId: string, grants: readonly Grant[]): Promise<ThreadMessage[]> {
  const rows = await db.message.findMany({
    where: { kind: "direct", OR: [{ targetAgentId: agentId }, { authorAgentId: agentId }] },
    select: SELECT,
    orderBy: { id: "desc" },
    take: THREAD_LIMIT
  });
  return rows
    .map(toLoaded)
    .filter((loaded) => canReadMessage(viewerOid, loaded.ref, grants))
    .map((loaded) => loaded.message)
    .reverse();
}

export const REPLIES_LIMIT = 100;

/** The oldest replies to a message, posts and direct messages alike, with the refs `canReadMessage` needs. */
export async function loadReplies(db: Database, id: bigint): Promise<LoadedThreadMessage[]> {
  const rows = await db.message.findMany({ where: { inReplyTo: id }, select: SELECT, orderBy: { id: "asc" }, take: REPLIES_LIMIT });
  return rows.map((row) => toLoaded(row));
}
