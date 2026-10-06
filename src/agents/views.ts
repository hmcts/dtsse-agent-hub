import { agentsVisibleTo, grantsHeldBy } from "../access/load.ts";
import { type AgentAccess, agentAccess, type Grant } from "../access/rules.ts";
import type { AgentStatus } from "../realtime/events.ts";
import type { Database } from "../store/prisma.ts";
import { byCodePoint } from "../topics/slug.ts";
import { virtualAgentsEnabled } from "../virtual-agents/settings.ts";
import { isUuid } from "./store.ts";

/** Agents as the web UI lists and shows them: only those the viewer may see, which `agentsVisibleTo` decides. */

export interface AgentCard {
  id: string;
  name: string;
  status: AgentStatus;
  repo: string | null;
  branch: string | null;
  lastHeartbeatAt: string;
  owner: { oid: string; name: string; email: string | null; tid: string };
  /** The virtual agent whose session this is, whose page is this agent's page, or `null` for a session on a laptop. */
  virtualAgentId: string | null;
}

export interface AgentDetail extends AgentCard {
  cwd: string | null;
  host: string | null;
  createdAt: string;
}

const CARD = {
  id: true,
  name: true,
  status: true,
  repo: true,
  branch: true,
  lastHeartbeatAt: true,
  owner: { select: { oid: true, name: true, email: true, tid: true } },
  virtualAgentId: true
} as const;

type CardRow = {
  id: string;
  name: string;
  status: AgentStatus;
  repo: string | null;
  branch: string | null;
  lastHeartbeatAt: Date;
  owner: { oid: string; name: string; email: string | null; tid: string };
  virtualAgentId: string | null;
};

function toCard(row: CardRow): AgentCard {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    repo: row.repo,
    branch: row.branch,
    lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
    owner: row.owner,
    // With virtual agents off their pages are not found, so their sessions are shown as the agents they are.
    virtualAgentId: virtualAgentsEnabled() ? row.virtualAgentId : null
  };
}

export const MAX_SIDEBAR_AGENTS = 100;

/** Live agents first, then the most recently heard from. */
export function byLiveness<A extends { status: AgentStatus; lastHeartbeatAt: string }>(agents: readonly A[]): A[] {
  const rank = (agent: A) => (agent.status === "offline" ? 1 : 0);
  return [...agents].sort((left, right) => rank(left) - rank(right) || byCodePoint(right.lastHeartbeatAt, left.lastHeartbeatAt));
}

/** The viewer's own agents, and those shared with them through a grant. */
export async function visibleAgents(db: Database, oid: string): Promise<{ mine: AgentCard[]; shared: AgentCard[] }> {
  const rows = await db.agent.findMany({
    where: agentsVisibleTo(oid),
    select: CARD,
    orderBy: [{ lastHeartbeatAt: "desc" }, { id: "asc" }],
    take: MAX_SIDEBAR_AGENTS
  });
  const cards = byLiveness(rows.map(toCard));
  return { mine: cards.filter((card) => card.owner.oid === oid), shared: cards.filter((card) => card.owner.oid !== oid) };
}

export interface AgentView {
  agent: AgentDetail;
  access: Exclude<AgentAccess, "none">;
  grants: Grant[];
}

/** The agent and what the viewer may do with it, or `undefined` when there is no such agent or they may not see it. */
export async function agentView(db: Database, viewerOid: string, id: string): Promise<AgentView | undefined> {
  if (!isUuid(id)) {
    return undefined;
  }
  const row = await db.agent.findUnique({
    where: { id },
    select: { ...CARD, ownerOid: true, cwd: true, host: true, createdAt: true }
  });
  if (row === null) {
    return undefined;
  }
  const grants = await grantsHeldBy(db, viewerOid);
  const access = agentAccess(viewerOid, { id: row.id, ownerOid: row.ownerOid }, grants);
  if (access === "none") {
    return undefined;
  }
  return {
    agent: { ...toCard(row), cwd: row.cwd, host: row.host, createdAt: row.createdAt.toISOString() },
    access,
    grants
  };
}
