import { canManageVirtualAgent } from "../access/rules.ts";
import { isUuid } from "../agents/store.ts";
import type { CredentialKind } from "../credentials/names.ts";
import type { Database } from "../store/prisma.ts";
import type { ModelRoute } from "../viewer/identity.ts";
import { lastActivity } from "./cleanup.ts";
import type { VirtualAgentDesired, VirtualAgentStatus } from "./lifecycle.ts";
import { type LoginView, loginViews } from "./logins.ts";
import type { StopReason } from "./stop.ts";
import { findVirtualAgent, listVirtualAgents, type VirtualAgentRow } from "./store.ts";

/** Virtual agents as their owner's pages show them. Nobody else ever sees one. */

export interface VirtualAgentCard {
  id: string;
  name: string;
  desired: VirtualAgentDesired;
  status: VirtualAgentStatus;
  statusDetail: string | null;
  modelRoute: ModelRoute;
  stopReason: StopReason | null;
  /** The latest pod report or transcript entry, or `null` before there has been either. */
  lastActivityAt: string | null;
  stoppedAt: string | null;
  diskExpiresAt: string | null;
  diskDeletedAt: string | null;
  agentId: string | null;
  createdAt: string;
}

export interface VirtualAgentDetail {
  card: VirtualAgentCard;
  logins: LoginView[];
  /** What this agent needs stored: GitHub and Azure always, and a Claude token on the owner's own licence. */
  needed: CredentialKind[];
}

function iso(date: Date | null | undefined): string | null {
  return date === null || date === undefined ? null : date.toISOString();
}

async function newestEntries(db: Database, agentIds: readonly string[]): Promise<Map<string, Date>> {
  if (agentIds.length === 0) {
    return new Map();
  }
  const rows = await db.transcriptEntry.groupBy({ by: ["agentId"], where: { agentId: { in: [...agentIds] } }, _max: { createdAt: true } });
  return new Map(rows.flatMap((row) => (row._max.createdAt === null ? [] : [[row.agentId, row._max.createdAt] as const])));
}

function toCard(row: VirtualAgentRow, newest: Map<string, Date>): VirtualAgentCard {
  return {
    id: row.id,
    name: row.name,
    desired: row.desired,
    status: row.status,
    statusDetail: row.statusDetail,
    modelRoute: row.modelRoute,
    stopReason: row.stopReason,
    lastActivityAt: iso(lastActivity(row.lastActiveAt, row.agentId === null ? undefined : newest.get(row.agentId))),
    stoppedAt: iso(row.stoppedAt),
    diskExpiresAt: iso(row.diskExpiresAt),
    diskDeletedAt: iso(row.diskDeletedAt),
    agentId: row.agentId,
    createdAt: row.createdAt.toISOString()
  };
}

export async function virtualAgentCards(db: Database, ownerOid: string): Promise<VirtualAgentCard[]> {
  const rows = await listVirtualAgents(db, ownerOid);
  const newest = await newestEntries(
    db,
    rows.flatMap((row) => (row.agentId === null ? [] : [row.agentId]))
  );
  return rows.map((row) => toCard(row, newest));
}

export function neededCredentials(route: ModelRoute): CredentialKind[] {
  return route === "own-licence" ? ["github", "azure", "claude"] : ["github", "azure", "bedrock"];
}

/** The agent, its logins and what it needs, or `undefined` when there is no such agent or it is not the viewer's. */
export async function virtualAgentDetail(db: Database, viewerOid: string, id: string): Promise<VirtualAgentDetail | undefined> {
  if (!isUuid(id)) {
    return undefined;
  }
  const row = await findVirtualAgent(db, id);
  if (row === undefined || !canManageVirtualAgent(viewerOid, row)) {
    return undefined;
  }
  const [newest, logins] = await Promise.all([newestEntries(db, row.agentId === null ? [] : [row.agentId]), loginViews(db, id)]);
  return { card: toCard(row, newest), logins, needed: neededCredentials(row.modelRoute) };
}
