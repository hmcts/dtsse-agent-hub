import { agentsMessageableBy } from "../access/load.ts";
import { conversationFlags } from "../access/rules.ts";
import type { Caller } from "../agent-auth/authenticate.ts";
import { linkLocalSession, linkSession } from "../assistant/store.ts";
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
  /**
   * What the registering client claimed it understands. Stored as reported and *replaced* every time, `undefined`
   * included, unlike `skills`: it describes the build now running the session, and a claim kept from an earlier
   * register would have the hub send a field this client does not read.
   */
  clientFeatures?: string[];
  /** The assistant conversation this session is for, sent by an assistant pod's conversation sessions only. */
  conversationId?: string | null;
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
 * A session for an assistant conversation (`conversationId` set) must come from that conversation's own virtual
 * agent. It adopts the agent the hub created with the conversation, or, after `/clear`, becomes the conversation's
 * current agent, and its wake is cleared; it never becomes the virtual agent's current agent, which an assistant
 * does not have.
 *
 * A re-registration whose skills differ from the stored ones announces them, so an open agent page re-reads its
 * composer's "/" autocomplete. A new agent's are not announced: no page can be showing it yet.
 *
 * A session on a person's own laptop — no virtual agent and no conversation named — gets a conversation of its own
 * with no pod behind it, so it appears in their Assistant.
 */
export async function registerAgent(prisma: PrismaClient, owner: Caller, registration: Registration): Promise<{ id: string; name: string }> {
  const virtualAgentId = owner.virtualAgentId ?? null;
  const skills = registration.skills === undefined ? null : JSON.stringify(registration.skills);
  const clientFeatures = registration.clientFeatures === undefined ? null : JSON.stringify(registration.clientFeatures);
  const conversationId = registration.conversationId ?? null;
  // Nobody's pod, and naming no conversation: a session on somebody's laptop.
  const local = virtualAgentId === null && conversationId === null;
  return await prisma.$transaction(async (tx) => {
    if (local) {
      // Taken before anything else this transaction writes, and on the session id rather than a row, because the row
      // may not exist yet: two registrations racing for one new session id would otherwise both insert the agent — one
      // of them through the conflict arm — and both go on to create it a conversation. Blocking rather than `try`,
      // since the loser's job is to find the conversation the winner made, not to skip its own registration. The key
      // is `hashtext`, so a 32-bit integer, and cannot collide with the sweeps' hand-picked 64-bit keys.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${registration.sessionId}::text))`;
    }
    if (virtualAgentId === null) {
      await upsertUser(tx, owner);
    }
    if (conversationId !== null) {
      const [conversation] =
        virtualAgentId === null || !isUuid(conversationId)
          ? []
          : await tx.$queryRaw<{ id: string }[]>`
              SELECT id::text AS id FROM assistant_conversation
               WHERE id = ${conversationId}::uuid AND virtual_agent_id = ${virtualAgentId}::uuid
                 FOR UPDATE`;
      if (conversation === undefined) {
        throw new SessionOwnedElsewhere("that conversation is not one of this virtual agent's");
      }
    }
    // Locked so a heartbeat cannot change the skills between this read and the upsert, which would announce wrongly.
    const [existing] =
      skills === null
        ? []
        : await tx.$queryRaw<
            { id: string; skills: unknown }[]
          >`SELECT id::text AS id, skills FROM agent WHERE session_id = ${registration.sessionId} FOR UPDATE`;
    const [agent] = await tx.$queryRaw<{ id: string; name: string; conversation_id: string | null }[]>`
      INSERT INTO agent (owner_oid, session_id, name, cwd, repo, branch, host, status, last_heartbeat_at, read_cursor, virtual_agent_id, skills, client_features, assistant_conversation_id)
      VALUES (
        ${owner.oid}, ${registration.sessionId},
        COALESCE((SELECT name FROM virtual_agent WHERE id = ${virtualAgentId}::uuid), ${registration.name}),
        ${registration.cwd}, ${registration.repo},
        ${registration.branch}, ${registration.host}, 'idle', now(), (SELECT COALESCE(max(id), 0) FROM message), ${virtualAgentId}::uuid,
        COALESCE(${skills}::jsonb, '[]'::jsonb), ${clientFeatures}::jsonb, ${conversationId}::uuid
      )
      ON CONFLICT (session_id) DO UPDATE
        SET name = EXCLUDED.name, cwd = EXCLUDED.cwd, repo = EXCLUDED.repo, branch = EXCLUDED.branch, host = EXCLUDED.host,
            status = 'idle', last_heartbeat_at = now(), ended_at = NULL, skills = COALESCE(${skills}::jsonb, agent.skills),
            -- Not COALESCEd, unlike the skills: whatever this register reported is what is running, nothing included.
            client_features = EXCLUDED.client_features
        WHERE agent.owner_oid = EXCLUDED.owner_oid AND agent.virtual_agent_id IS NOT DISTINCT FROM EXCLUDED.virtual_agent_id
          -- The second arm is a caller that is nobody's pod and names no conversation, which is a session on a
          -- laptop re-registering: it sends no conversation id and the hub's own link is already on the row, so
          -- demanding the two match would answer 409 and strip the bridge of its one recovery from a lost agent.
          -- Letting it through costs the guard nothing. Its purpose is that a launch token never adopts another
          -- chat's agent, and a pod's registration always carries the virtual agent its token names, so a pod never
          -- reaches this arm; nor can a laptop reach a pod's agent through it, which the virtual agent above
          -- already refuses. assistant_conversation_id is not in the SET list, so neither caller moves it.
          AND (agent.assistant_conversation_id IS NOT DISTINCT FROM EXCLUDED.assistant_conversation_id
               OR (EXCLUDED.virtual_agent_id IS NULL AND EXCLUDED.assistant_conversation_id IS NULL))
      RETURNING id::text AS id, name, assistant_conversation_id::text AS conversation_id
    `;
    if (agent === undefined) {
      throw new SessionOwnedElsewhere("that session id is registered to someone else");
    }
    await notify(tx, { type: "agent_status", agent_id: agent.id, owner_oid: owner.oid, status: "idle" });
    if (existing?.id === agent.id && registration.skills !== undefined && skillsChanged(storedSkills(existing.skills), normaliseSkills(registration.skills))) {
      await notify(tx, { type: "agent_skills", agent_id: agent.id, owner_oid: owner.oid });
    }
    if (virtualAgentId !== null && conversationId !== null) {
      await linkSession(tx, { conversationId, virtualAgentId, ownerOid: owner.oid, agentId: agent.id });
    } else if (virtualAgentId !== null) {
      await tx.virtualAgent.update({ where: { id: virtualAgentId }, data: { agentId: agent.id, lastActiveAt: new Date(), updatedAt: new Date() } });
      await notify(tx, { type: "virtual_agent", virtual_agent_id: virtualAgentId, owner_oid: owner.oid });
    } else if (local && agent.conversation_id === null) {
      // The column as the upsert left it, read under the advisory lock, so a re-registration finds the conversation
      // the first one made rather than making a second.
      await linkLocalSession(tx, { ownerOid: owner.oid, agentId: agent.id, name: agent.name });
    }
    return { id: agent.id, name: agent.name };
  });
}

export interface AgentRow {
  id: string;
  ownerOid: string;
  name: string;
  status: AgentStatus;
  /** The virtual agent whose session registered it, if any. */
  virtualAgentId: string | null;
  /** A pod conversation's agent, which no grant extends to. */
  ownerOnly: boolean;
  /** An agent in a conversation of either kind, whose transcript is its owner's alone. */
  inConversation: boolean;
}

export async function findAgent(db: Database, id: string): Promise<AgentRow | undefined> {
  const row = await db.agent.findUnique({
    where: { id },
    select: { id: true, ownerOid: true, name: true, status: true, virtualAgentId: true, assistantConversationId: true }
  });
  if (row === null) {
    return undefined;
  }
  const { assistantConversationId, ...agent } = row;
  return { ...agent, ...conversationFlags(row) };
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
  /** A pod conversation's agent: carried so the id arm below is held to the same rule the name arm's query applies. */
  ownerOnly: boolean;
}

/**
 * The agents `to_agent` could mean for a sender owned by `senderOid`: the agent with that id, or the messageable
 * agents with that name. Live agents are preferred over offline ones, so a session name reused across days
 * resolves to today's session; more than one live match is for the caller to report as ambiguous.
 *
 * An id is looked up without the access query, because `canAgentMessageAgent` decides on what comes back and the
 * caller's refusal says whether the agent exists; the conversation columns come back for that rule to read.
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
    owner: { select: { name: true } },
    assistantConversationId: true,
    virtualAgentId: true
  } as const;
  const rows = isUuid(toAgent)
    ? await db.agent.findMany({ where: { id: toAgent }, select })
    : await db.agent.findMany({ where: { AND: [{ name: toAgent }, agentsMessageableBy(senderOid)] }, select, orderBy: { lastHeartbeatAt: "desc" } });
  const candidates = rows.map(({ owner, assistantConversationId, virtualAgentId, ...row }) => ({
    ...row,
    ownerName: owner.name,
    ownerOnly: conversationFlags({ assistantConversationId, virtualAgentId }).ownerOnly
  }));
  const live = candidates.filter((candidate) => candidate.status !== "offline");
  return live.length > 0 ? live : candidates;
}
