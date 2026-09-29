import { notify } from "../realtime/notify.ts";
import type { Database, Prisma, PrismaClient } from "../store/prisma.ts";
import { canGrant, type Grant, type GrantLevel, type MessageRef } from "./rules.ts";

/** The loaders the rules in `rules.ts` are applied over, and the two writes those rules gate. */

export class AccessDenied extends Error {}

/** Every grant `oid` holds. The only grants that can change what `oid` may do. */
export async function grantsHeldBy(db: Database, oid: string): Promise<Grant[]> {
  const rows = await db.agentGrant.findMany({ where: { granteeOid: oid }, select: { ownerOid: true, granteeOid: true, level: true } });
  return rows.map((row) => ({ ownerOid: row.ownerOid, granteeOid: row.granteeOid, level: row.level }));
}

/** Agents `oid` may see: `canViewAgent`, as a query. */
export function agentsVisibleTo(oid: string): Prisma.AgentWhereInput {
  return { OR: [{ ownerOid: oid }, { owner: { grantsGiven: { some: { granteeOid: oid } } } }] };
}

/** Agents `oid`, or any agent `oid` owns, may message: `canPersonMessageAgent`, as a query. */
export function agentsMessageableBy(oid: string): Prisma.AgentWhereInput {
  return { OR: [{ ownerOid: oid }, { owner: { grantsGiven: { some: { granteeOid: oid, level: "write" } } } }] };
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
      authorAgent: { select: { id: true, ownerOid: true } },
      targetAgent: { select: { id: true, ownerOid: true } },
      parent: { select: { authorOid: true } }
    }
  });
  if (row === null) {
    return undefined;
  }
  const { parent, ...ref } = row;
  return { ...ref, parentAuthorOid: parent?.authorOid ?? null };
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
