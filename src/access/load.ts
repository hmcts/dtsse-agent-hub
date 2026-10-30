import type { Database, Prisma } from "../store/prisma.ts";
import type { MessageRef } from "./rules.ts";

/** The loaders the rules in `rules.ts` are applied over. */

/**
 * A pod conversation's agent, as a query: `isPodConversationAgent`, which is the CFT Workspace rather than a
 * session on the board. Both columns, because a conversation with no virtual agent is a session on its owner's
 * laptop, which is an ordinary agent.
 */
export const POD_CONVERSATION_AGENT: Prisma.AgentWhereInput = { assistantConversationId: { not: null }, virtualAgentId: { not: null } };

/**
 * Agents `oid`, or any agent `oid` owns, may message by name or pick from a list: `canPersonMessageAgent`, as a
 * query — their own — less every pod conversation's agent, which only its own conversation's page messages. Two
 * conditions rather than one, so not even its owner picks one of those out of a list of sessions; `agentsVisibleTo`
 * was the same shape and is gone, because the roster's own query is the owner's agents and nothing else.
 */
export function agentsMessageableBy(oid: string): Prisma.AgentWhereInput {
  return { ownerOid: oid, NOT: POD_CONVERSATION_AGENT };
}

export interface LoadedMessageRef extends MessageRef {
  id: bigint;
}

/**
 * A message as `canReadMessage`, `replyRoute` and `canLaunchTokenReadMessage` read it. An agent on it is its id and
 * its owner and nothing more: every rule those three apply is about who owns the thread, so `ownerOnly` — which only
 * `tagRefusal` reads, and a tag names an agent rather than a message — is not among the columns.
 */
export async function loadMessageRef(db: Database, id: bigint): Promise<LoadedMessageRef | undefined> {
  const row = await db.message.findUnique({
    where: { id },
    select: {
      id: true,
      kind: true,
      authorOid: true,
      authorAgent: { select: { id: true, ownerOid: true } },
      targetAgent: { select: { id: true, ownerOid: true } },
      parent: { select: { authorOid: true } }
    }
  });
  if (row === null) {
    return undefined;
  }
  const { parent, ...rest } = row;
  return { ...rest, parentAuthorOid: parent?.authorOid ?? null };
}

/** Every agent a virtual agent's sessions registered: what its launch token may act for and read as. */
export async function virtualAgentSessions(db: Database, virtualAgentId: string): Promise<string[]> {
  const rows = await db.agent.findMany({ where: { virtualAgentId }, select: { id: true } });
  return rows.map((row) => row.id);
}
