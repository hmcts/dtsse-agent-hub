import type { Database } from "../store/prisma.ts";
import type { GrantLevel } from "./rules.ts";

/** The grants on the access page, with the people on the other side of each. */

export interface GrantRow {
  level: GrantLevel;
  createdAt: string;
  person: { oid: string; name: string; email: string | null; tid: string };
}

const PERSON = { select: { oid: true, name: true, email: true, tid: true } } as const;

export async function grantsGiven(db: Database, ownerOid: string): Promise<GrantRow[]> {
  const rows = await db.agentGrant.findMany({ where: { ownerOid }, select: { level: true, createdAt: true, grantee: PERSON }, orderBy: { createdAt: "asc" } });
  return rows.map((row) => ({ level: row.level, createdAt: row.createdAt.toISOString(), person: row.grantee }));
}

export async function grantsReceived(db: Database, granteeOid: string): Promise<GrantRow[]> {
  const rows = await db.agentGrant.findMany({ where: { granteeOid }, select: { level: true, createdAt: true, owner: PERSON }, orderBy: { createdAt: "asc" } });
  return rows.map((row) => ({ level: row.level, createdAt: row.createdAt.toISOString(), person: row.owner }));
}
