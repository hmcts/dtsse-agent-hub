import { grantsHeldBy } from "../access/load.ts";
import { canManageVirtualAgent, canViewVirtualAgent } from "../access/rules.ts";
import { isUuid } from "../agents/store.ts";
import type { CredentialKind } from "../credentials/names.ts";
import type { Database } from "../store/prisma.ts";
import type { ModelRoute } from "../viewer/identity.ts";
import { lastActivity } from "./cleanup.ts";
import type { VirtualAgentDesired, VirtualAgentStatus } from "./lifecycle.ts";
import { type LoginView, loginViews } from "./logins.ts";
import { publicUrl } from "./ports.ts";
import { publicDomain } from "./settings.ts";
import type { VirtualAgentSize } from "./size.ts";
import type { StopReason } from "./stop.ts";
import { findVirtualAgent, listVirtualAgents, type VirtualAgentRow } from "./store.ts";

/**
 * Virtual agents as the pages show them: the summary anyone who may see one gets, and the cards and detail only its
 * owner does.
 */

export interface VirtualAgentCard {
  id: string;
  name: string;
  desired: VirtualAgentDesired;
  status: VirtualAgentStatus;
  statusDetail: string | null;
  modelRoute: ModelRoute;
  size: VirtualAgentSize;
  /** Each exposed port with the URL it is served at. */
  exposedPorts: { port: number; url: string }[];
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
  /** What it can use if stored, but starts without. */
  optional: CredentialKind[];
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
    size: row.size,
    exposedPorts: row.exposedPorts.map((port) => ({ port, url: publicUrl(row.statefulsetName, port, publicDomain()) })),
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

/** A Jenkins API token only adds the Jenkins tools, so the pod never waits for one. */
export const OPTIONAL_CREDENTIALS: CredentialKind[] = ["jenkins"];

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
  return { card: toCard(row, newest), logins, needed: neededCredentials(row.modelRoute), optional: OPTIONAL_CREDENTIALS };
}

/** What anyone who may see a virtual agent sees of it, which leaves out its sign-ins, credentials and ports. */
export interface VirtualAgentSummary {
  id: string;
  name: string;
  desired: VirtualAgentDesired;
  status: VirtualAgentStatus;
  /** The agent its current session registered, or `null` before one has. */
  agentId: string | null;
  owner: { oid: string; name: string; tid: string };
}

/** The virtual agent, or `undefined` when there is no such virtual agent or the viewer may not see it. */
export async function virtualAgentSummary(db: Database, viewerOid: string, id: string): Promise<VirtualAgentSummary | undefined> {
  if (!isUuid(id)) {
    return undefined;
  }
  const row = await db.virtualAgent.findUnique({
    where: { id },
    select: { id: true, ownerOid: true, name: true, desired: true, status: true, agentId: true, owner: { select: { oid: true, name: true, tid: true } } }
  });
  if (row === null || !canViewVirtualAgent(viewerOid, row, await grantsHeldBy(db, viewerOid))) {
    return undefined;
  }
  return { id: row.id, name: row.name, desired: row.desired, status: row.status, agentId: row.agentId, owner: row.owner };
}
