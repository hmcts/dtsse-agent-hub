import { agentsMessageableBy, POD_CONVERSATION_AGENT } from "../access/load.ts";
import { isPodConversationAgent } from "../access/rules.ts";
import type { Caller } from "../agent-auth/authenticate.ts";
import { linkLocalSession, linkSession } from "../assistant/store.ts";
import type { AgentStatus } from "../realtime/events.ts";
import { notify } from "../realtime/notify.ts";
import { likeLiteral } from "../store/like.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { upsertUser } from "../users/store.ts";
import { type NameSource, nameSourceOf } from "./name-source.ts";
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
  /**
   * Where `name` came from. Replaced on every registration as `clientFeatures` is, and for the same reason: it
   * describes the name this session is running under now. `derived` when a client did not say.
   */
  nameSource?: NameSource;
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
  const nameSource = nameSourceOf(registration.nameSource);
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
      INSERT INTO agent (owner_oid, session_id, name, name_source, cwd, repo, branch, host, status, last_heartbeat_at, read_cursor, virtual_agent_id, skills, client_features, assistant_conversation_id)
      VALUES (
        ${owner.oid}, ${registration.sessionId},
        COALESCE((SELECT name FROM virtual_agent WHERE id = ${virtualAgentId}::uuid), ${registration.name}),
        ${nameSource},
        ${registration.cwd}, ${registration.repo},
        ${registration.branch}, ${registration.host}, 'idle', now(), (SELECT COALESCE(max(id), 0) FROM message), ${virtualAgentId}::uuid,
        COALESCE(${skills}::jsonb, '[]'::jsonb), ${clientFeatures}::jsonb, ${conversationId}::uuid
      )
      ON CONFLICT (session_id) DO UPDATE
        SET name = EXCLUDED.name, cwd = EXCLUDED.cwd, repo = EXCLUDED.repo, branch = EXCLUDED.branch, host = EXCLUDED.host,
            status = 'idle', last_heartbeat_at = now(), ended_at = NULL, skills = COALESCE(${skills}::jsonb, agent.skills),
            -- Neither of these is COALESCEd, unlike the skills: whatever this register reported is what is running,
            -- nothing included. name_source goes with the name it describes, which this register also replaced.
            client_features = EXCLUDED.client_features, name_source = EXCLUDED.name_source
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
  /** A pod conversation's agent: the HMCTS Assistant, which no post may tag. */
  ownerOnly: boolean;
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
  return { ...agent, ownerOnly: isPodConversationAgent(row) };
}

/** Locks the agent's row for the rest of the transaction, and reads what a status or skills change is compared against. */
async function lockAgent(
  db: Database,
  agentId: string
): Promise<{ status: AgentStatus; ownerOid: string; virtualName: string | null; skills: Skill[]; name: string; local: boolean } | undefined> {
  const [row] = await db.$queryRaw<{ status: AgentStatus; owner_oid: string; virtual_name: string | null; skills: unknown; name: string; local: boolean }[]>`
    SELECT a.status::text AS status, a.owner_oid, v.name AS virtual_name, a.skills, a.name,
           (a.virtual_agent_id IS NULL AND a.assistant_conversation_id IS NULL) AS local
      FROM agent a LEFT JOIN virtual_agent v ON v.id = a.virtual_agent_id
     WHERE a.id = ${agentId}::uuid
       FOR UPDATE OF a
  `;
  return row === undefined
    ? undefined
    : {
        status: row.status,
        ownerOid: row.owner_oid,
        virtualName: row.virtual_name,
        skills: storedSkills(row.skills),
        name: row.name,
        local: row.local
      };
}

/**
 * Records a heartbeat, and announces the status when it changed. An agent the sweep marked offline comes back
 * with its next heartbeat. A virtual agent's session takes the name its owner gave the virtual agent, which also corrects one registered
 * under another name. `skills`, sent only when the session's list changed, replaces the stored list, and is announced
 * when it differs from it, so an open agent page re-reads its composer's "/" autocomplete.
 *
 * `nameSource` is stored with the name and only when the name is, so a heartbeat that reports no name says nothing
 * about where the stored one came from. That is what lets a `/rename` part-way through a session reach the hub
 * within a heartbeat, which is the whole reason a chat on somebody's own computer can keep the name they chose.
 */
export async function heartbeat(
  prisma: PrismaClient,
  agentId: string,
  status: Exclude<AgentStatus, "offline">,
  name: string | null,
  skills?: Skill[],
  nameSource?: NameSource
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
        ...(before.virtualName !== null ? { name: before.virtualName } : name === null ? {} : { name, nameSource: nameSourceOf(nameSource) })
      }
    });
    if (before.status !== status) {
      await notify(tx, { type: "agent_status", agent_id: agentId, owner_oid: before.ownerOid, status });
    }
    if (skills !== undefined && skillsChanged(before.skills, normaliseSkills(skills))) {
      await notify(tx, { type: "agent_skills", agent_id: agentId, owner_oid: before.ownerOid });
    }
    // A laptop session with no conversation gets one here as well as at registration, because registration is not
    // where most of them arrive. The client registers only while it holds no agent id and heartbeats ever after, so
    // every session already running when conversations were introduced — and every agent row written before then —
    // would otherwise never have had one, with nothing to create it later. Under the same row lock the heartbeat
    // already takes, so two heartbeats cannot both make one.
    if (before.local) {
      // The name this heartbeat reported, not the one the row held before it: the two differ exactly when the
      // client has just worked out a better one, and the chat made here would otherwise be named the worse of them.
      await linkLocalSession(tx, { ownerOid: before.ownerOid, agentId, name: name ?? before.name });
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

/**
 * The agents `oid` may message, live ones first and then most recently heard from: their own sessions, which is what
 * a direct message is between. Somebody else's agent is reached by tagging it in a post, and the agents a tag may
 * name are `searchTaggableAgents`' rather than this list's.
 */
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

/** One agent the post composer offers to tag. Carries what a post's byline already shows of it, and nothing more. */
export interface SuggestedAgent {
  id: string;
  ownerOid: string;
  name: string;
  ownerName: string;
  /** Read by `canSuggestAgent`, so the rule and not this query is the last word on what may be offered. */
  ownerOnly: boolean;
}

/**
 * Agents whose name starts with `query`, or carries it after a hyphen, live ones first and then most recently heard
 * from. A search, never a list: `agentLookup` in `src/access/rules.ts` decides that a query is specific enough to
 * answer at all and how many agents one answer may carry.
 *
 * A hyphen rather than any substring, so "pcs" finds `alice-pcs-api` without "api" finding every agent that has one
 * in its name. Every owner's, because tagging reaches every owner's; the pod conversation's agents it leaves out are
 * the ones nobody may tag.
 */
export async function searchTaggableAgents(db: Database, query: string, limit: number): Promise<SuggestedAgent[]> {
  const starts = `${likeLiteral(query)}%`;
  const afterHyphen = `%-${likeLiteral(query)}%`;
  // The pod conversations are left out here as well as by the rule, rather than only by it: a person with a dozen
  // chats has a dozen agents all named after their assistant, and a query matching that name would otherwise spend
  // the whole limit on rows the rule then drops and answer with nothing.
  const rows = await db.$queryRaw<
    { id: string; owner_oid: string; name: string; owner_name: string; conversation_id: string | null; virtual_agent_id: string | null }[]
  >`
    SELECT a.id::text AS id, a.owner_oid, a.name, u.name AS owner_name,
           a.assistant_conversation_id::text AS conversation_id, a.virtual_agent_id::text AS virtual_agent_id
      FROM agent a JOIN "user" u ON u.oid = a.owner_oid
     WHERE (lower(a.name) LIKE ${starts} OR lower(a.name) LIKE ${afterHyphen})
       AND NOT (a.assistant_conversation_id IS NOT NULL AND a.virtual_agent_id IS NOT NULL)
     ORDER BY (a.status = 'offline'), a.last_heartbeat_at DESC, a.id
     LIMIT ${limit}
  `;
  return rows.map((row) => ({
    id: row.id,
    ownerOid: row.owner_oid,
    name: row.name,
    ownerName: row.owner_name,
    ownerOnly: isPodConversationAgent({ assistantConversationId: row.conversation_id, virtualAgentId: row.virtual_agent_id })
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
 * What a name is matched among. `message` is the agents the sender may message — its owner's own — which `to_agent`
 * resolves in; `tag` is every agent but a pod conversation's, because anyone may tag anyone's (`tagRefusal` in
 * `src/access/rules.ts` is where that is decided and said).
 */
export type TargetScope = "message" | "tag";

/**
 * The agents a reference could mean for a sender owned by `senderOid`: the agent with that id, or the agents with
 * that name inside `scope`. Live agents are preferred over offline ones, so a session name reused across days
 * resolves to today's session; more than one live match is for the caller to report as ambiguous.
 *
 * An id is looked up without the access query in either scope, because the caller's rule decides on what comes back
 * and its refusal says whether the agent exists; the conversation columns come back for that rule to read.
 */
export async function resolveTargets(db: Database, senderOid: string, toAgent: string, scope: TargetScope = "message"): Promise<Candidate[]> {
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
  const named = scope === "message" ? agentsMessageableBy(senderOid) : { NOT: POD_CONVERSATION_AGENT };
  const rows = isUuid(toAgent)
    ? await db.agent.findMany({ where: { id: toAgent }, select })
    : await db.agent.findMany({ where: { AND: [{ name: toAgent }, named] }, select, orderBy: { lastHeartbeatAt: "desc" } });
  const candidates = rows.map(({ owner, assistantConversationId, virtualAgentId, ...row }) => ({
    ...row,
    ownerName: owner.name,
    ownerOnly: isPodConversationAgent({ assistantConversationId, virtualAgentId })
  }));
  const live = candidates.filter((candidate) => candidate.status !== "offline");
  return live.length > 0 ? live : candidates;
}
