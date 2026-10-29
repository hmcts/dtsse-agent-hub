import { notify } from "../realtime/notify.ts";
import type { Database, Prisma, PrismaClient } from "../store/prisma.ts";
import { canGrant, conversationFlags, type Grant, type GrantLevel, type MessageRef } from "./rules.ts";

/** The loaders the rules in `rules.ts` are applied over, and the two writes those rules gate. */

export class AccessDenied extends Error {}

/** Every grant `oid` holds. The only grants that can change what `oid` may do. */
export async function grantsHeldBy(db: Database, oid: string): Promise<Grant[]> {
  const rows = await db.agentGrant.findMany({ where: { granteeOid: oid }, select: { ownerOid: true, granteeOid: true, level: true } });
  return rows.map((row) => ({ ownerOid: row.ownerOid, granteeOid: row.granteeOid, level: row.level }));
}

/**
 * A pod conversation's agent, as a query: `conversationFlags`' `ownerOnly`, which no grant reaches. Both columns,
 * because a conversation with no virtual agent is a session on its owner's laptop and grants reach that as ever.
 */
export const POD_CONVERSATION_AGENT: Prisma.AgentWhereInput = { assistantConversationId: { not: null }, virtualAgentId: { not: null } };

/** Agents `oid` may see: `canViewAgent`, as a query. No grant reaches a pod conversation's agent. */
export function agentsVisibleTo(oid: string): Prisma.AgentWhereInput {
  return { OR: [{ ownerOid: oid }, { NOT: POD_CONVERSATION_AGENT, owner: { grantsGiven: { some: { granteeOid: oid } } } }] };
}

/**
 * Agents `oid`, or any agent `oid` owns, may message by name or pick from a list: `canPersonMessageAgent`, as a
 * query, less every pod conversation's agent, which only its own conversation's page messages. That exclusion is an
 * AND rather than part of the grant arm, so not even its owner picks one of those out of a list of sessions.
 */
export function agentsMessageableBy(oid: string): Prisma.AgentWhereInput {
  return {
    NOT: POD_CONVERSATION_AGENT,
    OR: [{ ownerOid: oid }, { owner: { grantsGiven: { some: { granteeOid: oid, level: "write" } } } }]
  };
}

export interface LoadedMessageRef extends MessageRef {
  id: bigint;
}

export async function loadMessageRef(db: Database, id: bigint): Promise<LoadedMessageRef | undefined> {
  const row = await db.message.findUnique({
    where: { id },
    select: {
      id: true,
      kind: true,
      authorOid: true,
      // The conversation columns as well: `canReadMessage` narrows a conversation's thread to its owner and reads
      // them off these refs, and without them it sees `undefined` and falls back to the grant.
      authorAgent: { select: { id: true, ownerOid: true, assistantConversationId: true, virtualAgentId: true } },
      targetAgent: { select: { id: true, ownerOid: true, assistantConversationId: true, virtualAgentId: true } },
      parent: { select: { authorOid: true } }
    }
  });
  if (row === null) {
    return undefined;
  }
  const { parent, authorAgent, targetAgent, ...rest } = row;
  return {
    ...rest,
    authorAgent: authorAgent === null ? null : { id: authorAgent.id, ownerOid: authorAgent.ownerOid, ...conversationFlags(authorAgent) },
    targetAgent: targetAgent === null ? null : { id: targetAgent.id, ownerOid: targetAgent.ownerOid, ...conversationFlags(targetAgent) },
    parentAuthorOid: parent?.authorOid ?? null
  };
}

/** Sets `actorOid`'s grant to `granteeOid`, and tells the grantee's open streams on commit. */
export async function setGrant(prisma: PrismaClient, actorOid: string, granteeOid: string, level: GrantLevel): Promise<void> {
  const known = (await prisma.user.count({ where: { oid: granteeOid } })) > 0;
  if (!canGrant(actorOid, actorOid, granteeOid, known)) {
    throw new AccessDenied(known ? "you cannot grant yourself access" : "that person has not used the hub yet, so cannot be granted access");
  }
  await prisma.$transaction(async (tx) => {
    await tx.agentGrant.upsert({
      where: { ownerOid_granteeOid: { ownerOid: actorOid, granteeOid } },
      create: { ownerOid: actorOid, granteeOid, level },
      update: { level }
    });
    await notify(tx, { type: "grant", owner_oid: actorOid, grantee_oid: granteeOid });
  });
}

export async function revokeGrant(prisma: PrismaClient, actorOid: string, granteeOid: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.agentGrant.deleteMany({ where: { ownerOid: actorOid, granteeOid } });
    if (count > 0) {
      await notify(tx, { type: "grant", owner_oid: actorOid, grantee_oid: granteeOid });
    }
  });
}

/** Every agent a virtual agent's sessions registered: what its launch token may act for and read as. */
export async function virtualAgentSessions(db: Database, virtualAgentId: string): Promise<string[]> {
  const rows = await db.agent.findMany({ where: { virtualAgentId }, select: { id: true } });
  return rows.map((row) => row.id);
}
