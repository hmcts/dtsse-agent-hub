import { agentsMessageableBy } from "../access/load.ts";
import type { Caller } from "../agent-auth/authenticate.ts";
import type { AgentStatus } from "../realtime/events.ts";
import { notify } from "../realtime/notify.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { upsertUser } from "../users/store.ts";
import { normaliseSkills, type Skill, skillsChanged, storedSkills } from "./skills.ts";

export interface Registration {
  sessionId: string;
  name: string;
  cwd: string | null;
  repo: string | null;
  branch: string | null;
  host: string | null;
  /** Left as stored when `undefined`: not every registration carries them. */
  skills?: Skill[];
}

export class SessionOwnedElsewhere extends Error {}

/**
 * Registers a session's agent, or refreshes it: idempotent on `session_id`, and a re-registration updates the
 * metadata and sets the agent `idle`.
 *
 * A new agent's read cursor starts at the newest message, so enabling comms does not replay the whole board into
 * the first feed read.
 *
 * A session id already registered by someone else is refused rather than taken over, which is what the `WHERE` on
 * the conflict arm does: it returns no row. The same goes for a session id registered by another virtual agent, or
 * by none when a launch token is registering it, so a launch token never adopts one of its owner's other agents.
 *
 * A virtual agent's session (`owner.virtualAgentId` set) is recorded as that virtual agent's current agent, which a
 * re-registration after `/clear` moves to the new session. Its owner's `user` row is not rewritten.
 * It is named after the virtual agent, whatever the session calls itself.
 *
 * A re-registration whose skills differ from the stored ones announces them, so an open agent page re-reads its
 * composer's "/" autocomplete. A new agent's are not announced: no page can be showing it yet.
 */
export async function registerAgent(prisma: PrismaClient, owner: Caller, registration: Registration): Promise<{ id: string; name: string }> {
  const virtualAgentId = owner.virtualAgentId ?? null;
  const skills = registration.skills === undefined ? null : JSON.stringify(registration.skills);
  return await prisma.$transaction(async (tx) => {
    if (virtualAgentId === null) {
      await upsertUser(tx, owner);
    }
    // Locked so a heartbeat cannot change the skills between this read and the upsert, which would announce wrongly.
    const [existing] =
      skills === null
        ? []
        : await tx.$queryRaw<
            { id: string; skills: unknown }[]
          >`SELECT id::text AS id, skills FROM agent WHERE session_id = ${registration.sessionId} FOR UPDATE`;
    const [agent] = await tx.$queryRaw<{ id: string; name: string }[]>`
      INSERT INTO agent (owner_oid, session_id, name, cwd, repo, branch, host, status, last_heartbeat_at, read_cursor, virtual_agent_id, skills)
      VALUES (
        ${owner.oid}, ${registration.sessionId},
        COALESCE((SELECT name FROM virtual_agent WHERE id = ${virtualAgentId}::uuid), ${registration.name}),
        ${registration.cwd}, ${registration.repo},
        ${registration.branch}, ${registration.host}, 'idle', now(), (SELECT COALESCE(max(id), 0) FROM message), ${virtualAgentId}::uuid,
        COALESCE(${skills}::jsonb, '[]'::jsonb)
      )
      ON CONFLICT (session_id) DO UPDATE
        SET name = EXCLUDED.name, cwd = EXCLUDED.cwd, repo = EXCLUDED.repo, branch = EXCLUDED.branch, host = EXCLUDED.host,
            status = 'idle', last_heartbeat_at = now(), ended_at = NULL, skills = COALESCE(${skills}::jsonb, agent.skills)
        WHERE agent.owner_oid = EXCLUDED.owner_oid AND agent.virtual_agent_id IS NOT DISTINCT FROM EXCLUDED.virtual_agent_id
      RETURNING id::text AS id, name
    `;
    if (agent === undefined) {
      throw new SessionOwnedElsewhere("that session id is registered to someone else");
    }
    await notify(tx, { type: "agent_status", agent_id: agent.id, owner_oid: owner.oid, status: "idle" });
    if (existing?.id === agent.id && registration.skills !== undefined && skillsChanged(storedSkills(existing.skills), normaliseSkills(registration.skills))) {
      await notify(tx, { type: "agent_skills", agent_id: agent.id, owner_oid: owner.oid });
    }
    if (virtualAgentId !== null) {
      await tx.virtualAgent.update({ where: { id: virtualAgentId }, data: { agentId: agent.id, lastActiveAt: new Date(), updatedAt: new Date() } });
      await notify(tx, { type: "virtual_agent", virtual_agent_id: virtualAgentId, owner_oid: owner.oid });
    }
    return agent;
  });
}

export interface AgentRow {
  id: string;
  ownerOid: string;
  name: string;
  status: AgentStatus;
  /** The virtual agent whose session registered it, if any. */
  virtualAgentId: string | null;
}

export async function findAgent(db: Database, id: string): Promise<AgentRow | undefined> {
  const row = await db.agent.findUnique({ where: { id }, select: { id: true, ownerOid: true, name: true, status: true, virtualAgentId: true } });
  return row ?? undefined;
}

/** Locks the agent's row for the rest of the transaction, and reads what a status or skills change is compared against. */
async function lockAgent(
  db: Database,
  agentId: string
): Promise<{ status: AgentStatus; ownerOid: string; virtualName: string | null; skills: Skill[] } | undefined> {
  const [row] = await db.$queryRaw<{ status: AgentStatus; owner_oid: string; virtual_name: string | null; skills: unknown }[]>`
    SELECT a.status::text AS status, a.owner_oid, v.name AS virtual_name, a.skills
      FROM agent a LEFT JOIN virtual_agent v ON v.id = a.virtual_agent_id
     WHERE a.id = ${agentId}::uuid
       FOR UPDATE OF a
  `;
  return row === undefined ? undefined : { status: row.status, ownerOid: row.owner_oid, virtualName: row.virtual_name, skills: storedSkills(row.skills) };
}

/**
 * Records a heartbeat, and announces the status when it changed. An agent the sweep marked offline comes back
 * with its next heartbeat. A virtual agent's session takes the name its owner gave the virtual agent, which also corrects one registered
 * under another name. `skills`, sent only when the session's list changed, replaces the stored list, and is announced
 * when it differs from it, so an open agent page re-reads its composer's "/" autocomplete.
 */
export async function heartbeat(
  prisma: PrismaClient,
  agentId: string,
  status: Exclude<AgentStatus, "offline">,
  name: string | null,
  skills?: Skill[]
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const before = await lockAgent(tx, agentId);
    if (before === undefined) {
      return;
    }
    await tx.agent.update({
      where: { id: agentId },
      data: {
        status,
        lastHeartbeatAt: new Date(),
        endedAt: null,
        ...(skills === undefined ? {} : { skills: skills.map(({ name, description }) => ({ name, description })) }),
        ...(before.virtualName !== null ? { name: before.virtualName } : name === null ? {} : { name })
      }
    });
    if (before.status !== status) {
      await notify(tx, { type: "agent_status", agent_id: agentId, owner_oid: before.ownerOid, status });
    }
    if (skills !== undefined && skillsChanged(before.skills, normaliseSkills(skills))) {
      await notify(tx, { type: "agent_skills", agent_id: agentId, owner_oid: before.ownerOid });
    }
  });
}

export async function markOffline(prisma: PrismaClient, agentId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const before = await lockAgent(tx, agentId);
    if (before === undefined) {
      return;
    }
    await tx.agent.update({ where: { id: agentId }, data: { status: "offline", endedAt: new Date() } });
    if (before.status !== "offline") {
      await notify(tx, { type: "agent_status", agent_id: agentId, owner_oid: before.ownerOid, status: "offline" });
    }
  });
}

export async function storeReadCursor(db: Database, agentId: string, cursor: bigint): Promise<void> {
  await db.agent.update({ where: { id: agentId }, data: { readCursor: cursor } });
}

export async function readCursor(db: Database, agentId: string): Promise<bigint> {
  const row = await db.agent.findUnique({ where: { id: agentId }, select: { readCursor: true } });
  return row?.readCursor ?? 0n;
}

export interface ListedAgent {
  id: string;
  name: string;
  status: AgentStatus;
  repo: string | null;
  branch: string | null;
  last_heartbeat_at: string;
  owner: { name: string; email: string | null };
}

export const MAX_LISTED_AGENTS = 200;

/** The agents `oid` may message, live ones first and then most recently heard from. */
export async function listMessageableAgents(db: Database, oid: string): Promise<ListedAgent[]> {
  const rows = await db.agent.findMany({
    where: agentsMessageableBy(oid),
    select: {
      id: true,
      name: true,
      status: true,
      repo: true,
      branch: true,
      lastHeartbeatAt: true,
      owner: { select: { name: true, email: true } }
    },
    orderBy: [{ lastHeartbeatAt: "desc" }, { id: "asc" }],
    take: MAX_LISTED_AGENTS
  });
  const live = rows.filter((row) => row.status !== "offline");
  const offline = rows.filter((row) => row.status === "offline");
  return [...live, ...offline].map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    repo: row.repo,
    branch: row.branch,
    last_heartbeat_at: row.lastHeartbeatAt.toISOString(),
    owner: row.owner
  }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export interface Candidate {
  id: string;
  ownerOid: string;
  name: string;
  status: AgentStatus;
  repo: string | null;
  branch: string | null;
  lastHeartbeatAt: Date;
  ownerName: string;
}

/**
 * The agents `to_agent` could mean for a sender owned by `senderOid`: the agent with that id, or the messageable
 * agents with that name. Live agents are preferred over offline ones, so a session name reused across days
 * resolves to today's session; more than one live match is for the caller to report as ambiguous.
 */
export async function resolveTargets(db: Database, senderOid: string, toAgent: string): Promise<Candidate[]> {
  const select = {
    id: true,
    ownerOid: true,
    name: true,
    status: true,
    repo: true,
    branch: true,
    lastHeartbeatAt: true,
    owner: { select: { name: true } }
  } as const;
  const rows = isUuid(toAgent)
    ? await db.agent.findMany({ where: { id: toAgent }, select })
    : await db.agent.findMany({ where: { AND: [{ name: toAgent }, agentsMessageableBy(senderOid)] }, select, orderBy: { lastHeartbeatAt: "desc" } });
  const candidates = rows.map(({ owner, ...row }) => ({ ...row, ownerName: owner.name }));
  const live = candidates.filter((candidate) => candidate.status !== "offline");
  return live.length > 0 ? live : candidates;
}
