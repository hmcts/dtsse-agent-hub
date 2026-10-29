import { type AgentConversationColumns, canReadMessage, conversationFlags, type Grant, type MessageRef } from "../access/rules.ts";
import { ATTACHMENT_SELECT, attachmentView, type MessageAttachment } from "../assistant/upload-store.ts";
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
  /**
   * Files the person attached, for the Assistant's thread to show as chips, and empty for every other message.
   * Optional so a message built by hand — a send's own answer before it is read back, a test's fixture — needs no
   * empty array of its own; everything loaded from the database carries one. `threadItems` normalises it.
   */
  attachments?: MessageAttachment[];
}

export interface LoadedThreadMessage {
  message: ThreadMessage;
  ref: MessageRef;
}

// The two conversation columns on each agent, because `canReadMessage` narrows a conversation's thread to its owner
// and reads them off the ref. Without them here the rule sees `undefined` and falls back to the grant, which is the
// whole of what it is there to refuse.
const AGENT_ACCESS = { assistantConversationId: true, virtualAgentId: true } as const;

const SELECT = {
  ...MESSAGE_SELECT,
  authorOid: true,
  authorAgent: { select: { id: true, name: true, ownerOid: true, ...AGENT_ACCESS } },
  targetAgent: { select: { id: true, ownerOid: true, ...AGENT_ACCESS } },
  parent: { select: { authorOid: true } },
  deliveries: { select: { agentId: true, state: true } },
  uploads: { select: ATTACHMENT_SELECT, orderBy: { createdAt: "asc" } }
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
  authorAgent: ({ id: string; name: string; ownerOid: string } & AgentConversationColumns) | null;
  author: { name: string; email: string | null };
  topics: { topic: { slug: string } }[];
  targetAgent: ({ id: string; ownerOid: string } & AgentConversationColumns) | null;
  parent: { authorOid: string } | null;
  deliveries: { agentId: string; state: DeliveryView }[];
  uploads: { id: string; fileName: string; bytes: bigint; mediaType: string; state: string; createdAt: Date }[];
};

function toLoaded(row: Row): LoadedThreadMessage {
  const delivery = row.deliveries.find((entry) => entry.agentId === row.targetAgentId)?.state ?? null;
  const attachments = row.uploads.map(attachmentView);
  return {
    message: { ...toApiMessage(row), delivery, attachments },
    ref: {
      kind: row.kind,
      authorOid: row.authorOid,
      authorAgent: row.authorAgent === null ? null : { id: row.authorAgent.id, ownerOid: row.authorAgent.ownerOid, ...conversationFlags(row.authorAgent) },
      targetAgent: row.targetAgent === null ? null : { id: row.targetAgent.id, ownerOid: row.targetAgent.ownerOid, ...conversationFlags(row.targetAgent) },
      parentAuthorOid: row.parent?.authorOid ?? null
    }
  };
}

export async function loadThreadMessage(db: Database, id: bigint): Promise<LoadedThreadMessage | undefined> {
  const row = await db.message.findUnique({ where: { id }, select: SELECT });
  return row === null ? undefined : toLoaded(row);
}

export const THREAD_LIMIT = 100;

/** Bounds on when a thread's messages were sent: from `since` inclusive, before `until`. */
export interface ThreadWindow {
  since?: Date;
  until?: Date;
}

/** The latest direct messages in the agent's thread that the viewer may read, within `window`, oldest first. */
export async function agentThread(
  db: Database,
  viewerOid: string,
  agentId: string,
  grants: readonly Grant[],
  window: ThreadWindow = {}
): Promise<ThreadMessage[]> {
  const createdAt = { ...(window.since === undefined ? {} : { gte: window.since }), ...(window.until === undefined ? {} : { lt: window.until }) };
  const rows = await db.message.findMany({
    where: { kind: "direct", OR: [{ targetAgentId: agentId }, { authorAgentId: agentId }], ...(Object.keys(createdAt).length === 0 ? {} : { createdAt }) },
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
