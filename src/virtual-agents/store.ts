import { canManageVirtualAgent } from "../access/rules.ts";
import { HttpError } from "../agent-api/http.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import type { Identity } from "../users/identity.ts";
import type { ModelRoute } from "../viewer/identity.ts";
import { CLAIM_TIMEOUT_MS, diskExpiresAt } from "./cleanup.ts";
import { hashLaunchToken, isWellFormedLaunchToken, launchTokenMatches, mintLaunchToken } from "./launch-token.ts";
import { nextStatus, type Observation, type PodPhase, type VirtualAgentDesired, type VirtualAgentStatus } from "./lifecycle.ts";
import { checkName, createRefusal, startRefusal } from "./limits.ts";
import { checkPort, exposeRefusal, withoutPort, withPort } from "./ports.ts";
import { diskTtlDays, orchestratorLeaseSeconds } from "./settings.ts";
import { checkSize, sizeChangeRefusal, type VirtualAgentSize } from "./size.ts";
import { announce, type StopReason } from "./stop.ts";

/**
 * Virtual agents: what each person asked for, what the orchestrator and the pod last reported, and the launch token
 * the pod authenticates with. Every change is announced to the owner's UI streams with a `virtual_agent` event.
 */

export interface VirtualAgentRow {
  id: string;
  ownerOid: string;
  name: string;
  desired: VirtualAgentDesired;
  status: VirtualAgentStatus;
  statusDetail: string | null;
  statusChangedAt: Date;
  generation: number;
  observedGeneration: number;
  statefulsetName: string;
  pvcName: string;
  agentId: string | null;
  modelRoute: ModelRoute;
  size: VirtualAgentSize;
  exposedPorts: number[];
  startedAt: Date;
  lastActiveAt: Date | null;
  stoppedAt: Date | null;
  stopReason: StopReason | null;
  diskExpiresAt: Date | null;
  diskDeletedAt: Date | null;
  createdAt: Date;
}

const SELECT = {
  id: true,
  ownerOid: true,
  name: true,
  desired: true,
  status: true,
  statusDetail: true,
  statusChangedAt: true,
  generation: true,
  observedGeneration: true,
  statefulsetName: true,
  pvcName: true,
  agentId: true,
  modelRoute: true,
  size: true,
  exposedPorts: true,
  startedAt: true,
  lastActiveAt: true,
  stoppedAt: true,
  stopReason: true,
  diskExpiresAt: true,
  diskDeletedAt: true,
  createdAt: true
} as const;

type StoredRoute = "bedrock" | "own_licence";

function toRoute(stored: StoredRoute): ModelRoute {
  return stored === "own_licence" ? "own-licence" : "bedrock";
}

function fromRoute(route: ModelRoute): StoredRoute {
  return route === "own-licence" ? "own_licence" : "bedrock";
}

function toRow<R extends { modelRoute: StoredRoute }>(row: R): Omit<R, "modelRoute"> & { modelRoute: ModelRoute } {
  return { ...row, modelRoute: toRoute(row.modelRoute) };
}

/** Holds the owner's `user` row until commit, so two creates or starts by one person cannot both pass the limits. */
async function lockOwner(db: Database, ownerOid: string): Promise<void> {
  await db.$queryRaw`SELECT 1 FROM "user" WHERE oid = ${ownerOid} FOR UPDATE`;
}

async function counts(db: Database, ownerOid: string): Promise<{ total: number; running: number }> {
  const [total, running] = await Promise.all([
    db.virtualAgent.count({ where: { ownerOid, desired: { not: "deleted" } } }),
    db.virtualAgent.count({ where: { ownerOid, desired: "running" } })
  ]);
  return { total, running };
}

/** Locks the row for the rest of the transaction. */
async function lockVirtualAgent(db: Database, id: string): Promise<VirtualAgentRow | undefined> {
  const [locked] = await db.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM virtual_agent WHERE id = ${id}::uuid FOR UPDATE`;
  if (locked === undefined) {
    return undefined;
  }
  return toRow(await db.virtualAgent.findUniqueOrThrow({ where: { id }, select: SELECT }));
}

export interface NewVirtualAgent {
  owner: Pick<Identity, "oid">;
  modelRoute: ModelRoute;
  name: unknown;
  /** `small` when not given. */
  size?: unknown;
}

/**
 * A new virtual agent, meant to be running, for the orchestrator to claim. Its model route is the owner's at the
 * moment they created it, since that decides whether the pod needs their Claude token.
 */
export async function createVirtualAgent(prisma: PrismaClient, request: NewVirtualAgent): Promise<VirtualAgentRow> {
  const checked = checkName(request.name);
  if (!checked.ok) {
    throw new HttpError(400, checked.error);
  }
  const size = checkSize(request.size);
  if (!size.ok) {
    throw new HttpError(400, size.error);
  }
  return await prisma.$transaction(async (tx) => {
    await lockOwner(tx, request.owner.oid);
    const refusal = createRefusal(await counts(tx, request.owner.oid));
    if (refusal !== undefined) {
      throw new HttpError(409, refusal);
    }
    if ((await tx.virtualAgent.count({ where: { ownerOid: request.owner.oid, name: checked.name } })) > 0) {
      throw new HttpError(409, `you already have a virtual agent called ${checked.name}`);
    }
    const row = toRow(
      await tx.virtualAgent.create({
        data: { ownerOid: request.owner.oid, name: checked.name, modelRoute: fromRoute(request.modelRoute), size: size.size },
        select: SELECT
      })
    );
    await announce(tx, row.id, row.ownerOid);
    return row;
  });
}

export async function findVirtualAgent(db: Database, id: string): Promise<VirtualAgentRow | undefined> {
  const row = await db.virtualAgent.findUnique({ where: { id }, select: SELECT });
  return row === null ? undefined : toRow(row);
}

/** The owner's virtual agents, oldest first. */
export async function listVirtualAgents(db: Database, ownerOid: string): Promise<VirtualAgentRow[]> {
  const rows = await db.virtualAgent.findMany({ where: { ownerOid }, select: SELECT, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  return rows.map(toRow);
}

const NO_TOKEN = { launchTokenHash: null, launchTokenIssuedAt: null } as const;

/**
 * What the owner asks for: start, stop or delete. Each bumps `generation`, so the orchestrator claims the agent and
 * applies it. Stopping or deleting drops the launch token at once, so the pod is shut out before it is shut down;
 * starting again clears the last stop and the disk's expiry, and the next claim mints a fresh token.
 *
 * Someone other than the owner is told there is no such agent, so the refusal does not confirm one exists.
 */
export async function setDesired(
  prisma: PrismaClient,
  actorOid: string,
  id: string,
  desired: VirtualAgentDesired,
  now: Date = new Date()
): Promise<VirtualAgentRow> {
  return await prisma.$transaction(async (tx) => {
    const row = await lockVirtualAgent(tx, id);
    if (row === undefined || !canManageVirtualAgent(actorOid, row)) {
      throw new HttpError(404, "no such virtual agent");
    }
    if (row.desired === "deleted") {
      throw new HttpError(409, "that virtual agent is being deleted");
    }
    if (row.desired === desired) {
      return row;
    }
    let data: Record<string, unknown>;
    if (desired === "running") {
      await lockOwner(tx, row.ownerOid);
      const refusal = startRefusal(await counts(tx, row.ownerOid));
      if (refusal !== undefined) {
        throw new HttpError(409, refusal);
      }
      data = { startedAt: now, stoppedAt: null, stopReason: null, diskExpiresAt: null, diskDeletedAt: null, statusDetail: null };
    } else {
      data = { ...NO_TOKEN, ...(desired === "stopped" ? { stopReason: "user" } : {}) };
    }
    const updated = toRow(
      await tx.virtualAgent.update({
        where: { id },
        data: { ...data, desired, generation: { increment: 1 }, updatedAt: now },
        select: SELECT
      })
    );
    await announce(tx, id, row.ownerOid);
    return updated;
  });
}

/**
 * Gives the virtual agent a new name, and its sessions with it, since a heartbeat would otherwise put the old one
 * back. The StatefulSet and disk are named from the id, so the pod is not touched. The owner's `user` row is held as
 * in a create, so a rename and a create of the same name cannot both pass the check.
 */
export async function renameVirtualAgent(prisma: PrismaClient, actorOid: string, id: string, name: unknown, now: Date = new Date()): Promise<VirtualAgentRow> {
  const checked = checkName(name);
  if (!checked.ok) {
    throw new HttpError(400, checked.error);
  }
  return await prisma.$transaction(async (tx) => {
    const row = await lockVirtualAgent(tx, id);
    if (row === undefined || !canManageVirtualAgent(actorOid, row)) {
      throw new HttpError(404, "no such virtual agent");
    }
    if (row.desired === "deleted") {
      throw new HttpError(409, "that virtual agent is being deleted");
    }
    if (row.name === checked.name) {
      return row;
    }
    await lockOwner(tx, row.ownerOid);
    if ((await tx.virtualAgent.count({ where: { ownerOid: row.ownerOid, name: checked.name } })) > 0) {
      throw new HttpError(409, `you already have a virtual agent called ${checked.name}`);
    }
    const updated = toRow(await tx.virtualAgent.update({ where: { id }, data: { name: checked.name, updatedAt: now }, select: SELECT }));
    await tx.agent.updateMany({ where: { virtualAgentId: id }, data: { name: checked.name } });
    await announce(tx, id, row.ownerOid);
    return updated;
  });
}

/**
 * A new size, bumping `generation` so the orchestrator applies the StatefulSet again with its resources. Refused
 * while a pod may be running, per `sizeChangeRefusal`; someone other than the owner is told there is no such agent.
 */
export async function setVirtualAgentSize(prisma: PrismaClient, actorOid: string, id: string, size: unknown, now: Date = new Date()): Promise<VirtualAgentRow> {
  const checked = checkSize(size);
  if (!checked.ok) {
    throw new HttpError(400, checked.error);
  }
  return await prisma.$transaction(async (tx) => {
    const row = await lockVirtualAgent(tx, id);
    if (row === undefined || !canManageVirtualAgent(actorOid, row)) {
      throw new HttpError(404, "no such virtual agent");
    }
    const refusal = sizeChangeRefusal(row);
    if (refusal !== undefined) {
      throw new HttpError(409, refusal);
    }
    if (row.size === checked.size) {
      return row;
    }
    const updated = toRow(
      await tx.virtualAgent.update({ where: { id }, data: { size: checked.size, generation: { increment: 1 }, updatedAt: now }, select: SELECT })
    );
    await announce(tx, id, row.ownerOid);
    return updated;
  });
}

/**
 * Exposes or stops exposing one of the agent's web ports, in any state but deleted, bumping `generation` so the
 * orchestrator applies its Service, Ingress and pod again. Someone other than the owner is told there is no such
 * agent.
 */
export async function setExposedPort(
  prisma: PrismaClient,
  actorOid: string,
  id: string,
  port: unknown,
  exposed: boolean,
  now: Date = new Date()
): Promise<VirtualAgentRow> {
  const checked = checkPort(port);
  if (!checked.ok) {
    throw new HttpError(400, checked.error);
  }
  return await prisma.$transaction(async (tx) => {
    const row = await lockVirtualAgent(tx, id);
    if (row === undefined || !canManageVirtualAgent(actorOid, row)) {
      throw new HttpError(404, "no such virtual agent");
    }
    if (row.desired === "deleted") {
      throw new HttpError(409, "that virtual agent is being deleted");
    }
    if (exposed) {
      const refusal = exposeRefusal(row.exposedPorts, checked.port);
      if (refusal !== undefined) {
        throw new HttpError(409, refusal);
      }
    } else if (!row.exposedPorts.includes(checked.port)) {
      return row;
    }
    const ports = exposed ? withPort(row.exposedPorts, checked.port) : withoutPort(row.exposedPorts, checked.port);
    const updated = toRow(
      await tx.virtualAgent.update({ where: { id }, data: { exposedPorts: ports, generation: { increment: 1 }, updatedAt: now }, select: SELECT })
    );
    await announce(tx, id, row.ownerOid);
    return updated;
  });
}

export interface LaunchTokenCaller extends Identity {
  virtualAgentId: string;
}

/**
 * The owner a launch token acts as, or `undefined` for a token that is malformed, unknown, replaced by a newer one,
 * or whose agent is no longer meant to be running.
 */
export async function callerForLaunchToken(db: Database, token: string): Promise<LaunchTokenCaller | undefined> {
  if (!isWellFormedLaunchToken(token)) {
    return undefined;
  }
  const row = await db.virtualAgent.findUnique({
    where: { launchTokenHash: hashLaunchToken(token) },
    select: { id: true, desired: true, launchTokenHash: true, owner: { select: { oid: true, tid: true, name: true, email: true } } }
  });
  if (row === null || row.desired !== "running" || !launchTokenMatches(token, row.launchTokenHash)) {
    return undefined;
  }
  const { oid, tid, name, email } = row.owner;
  return { oid, tid, name, ...(email === null ? {} : { email }), virtualAgentId: row.id };
}

/**
 * The pod's report of how far its boot has got. Refused with 409 when the lifecycle does not allow it, such as from
 * an agent that is being stopped. Every report counts as activity.
 */
export async function reportStatus(prisma: PrismaClient, id: string, phase: PodPhase, detail: string | null, now: Date = new Date()): Promise<VirtualAgentRow> {
  return await prisma.$transaction(async (tx) => {
    const row = await lockVirtualAgent(tx, id);
    if (row === undefined) {
      throw new HttpError(404, "no such virtual agent");
    }
    const outcome = nextStatus(row, { source: "pod", phase, detail });
    if ("refused" in outcome) {
      throw new HttpError(409, outcome.refused);
    }
    if ("remove" in outcome) {
      throw new Error("a pod report never removes an agent");
    }
    const updated = toRow(
      await tx.virtualAgent.update({
        where: { id },
        data: {
          status: outcome.status,
          statusDetail: outcome.detail ?? null,
          ...(outcome.status === row.status ? {} : { statusChangedAt: now }),
          lastActiveAt: now,
          updatedAt: now
        },
        select: SELECT
      })
    );
    await announce(tx, id, row.ownerOid);
    return updated;
  });
}

/** Moves the agent as a pod report of `phase` would, when the lifecycle allows it, inside the caller's transaction. */
export async function moveTo(db: Database, row: VirtualAgentRow, phase: PodPhase, detail: string | null, now: Date): Promise<void> {
  const outcome = nextStatus(row, { source: "pod", phase, detail });
  if (!("status" in outcome)) {
    return;
  }
  await db.virtualAgent.update({
    where: { id: row.id },
    data: { status: outcome.status, statusDetail: outcome.detail ?? null, ...(outcome.status === row.status ? {} : { statusChangedAt: now }), updatedAt: now }
  });
}

export interface ClaimedVirtualAgent {
  id: string;
  generation: number;
  desired: VirtualAgentDesired;
  statefulset_name: string;
  pvc_name: string;
  delete_disk: boolean;
  model_route: StoredRoute;
  size: VirtualAgentSize;
  exposed_ports: number[];
  owner: { oid: string };
  /** Only when this claim minted one. It is never stored and never returned again. */
  launch_token?: string;
}

export const CLAIM_LIMIT = 20;

/** Statuses from which `running` means a new pod, which needs a token of its own. */
const STARTING_FROM: readonly VirtualAgentStatus[] = ["requested", "stopping", "stopped"];

interface ClaimRow {
  id: string;
  generation: number;
  desired: VirtualAgentDesired;
  status: VirtualAgentStatus;
  statefulset_name: string;
  pvc_name: string;
  model_route: StoredRoute;
  size: VirtualAgentSize;
  exposed_ports: number[];
  owner_oid: string;
  has_token: boolean;
  disk_due: boolean;
}

export interface OrchestratorLease {
  cluster: string;
  renewed_at: string;
}

/** What a claim answers: the agents claimed, or, while another cluster holds the lease, nothing and who holds it. */
export type ClaimResult = { active: true; virtual_agents: ClaimedVirtualAgent[] } | { active: false; virtual_agents: []; lease: OrchestratorLease };

export interface ClaimOptions {
  limit?: number;
  now?: Date;
  leaseSeconds?: number;
}

interface LeaseRow {
  cluster: string;
  renewed_at: Date;
}

/**
 * Takes or renews the single orchestrator lease for `cluster`, holding its row locked for the rest of the
 * transaction, so claims are made one at a time and only by the holder. `undefined` when `cluster` holds it now;
 * otherwise the other cluster's fresh lease.
 */
async function takeLease(db: Database, cluster: string, now: Date, leaseSeconds: number): Promise<LeaseRow | undefined> {
  const stale = new Date(now.getTime() - leaseSeconds * 1000);
  const [previous] = await db.$queryRaw<LeaseRow[]>`SELECT cluster, renewed_at FROM orchestrator_lease WHERE id = 1 FOR UPDATE`;
  if (previous !== undefined && previous.cluster !== cluster && previous.renewed_at > stale) {
    return previous;
  }
  const taken = await db.$queryRaw<LeaseRow[]>`
    INSERT INTO orchestrator_lease (id, cluster, renewed_at) VALUES (1, ${cluster}, ${now})
    ON CONFLICT (id) DO UPDATE SET cluster = EXCLUDED.cluster, renewed_at = EXCLUDED.renewed_at
     WHERE orchestrator_lease.cluster = EXCLUDED.cluster OR orchestrator_lease.renewed_at <= ${stale}
    RETURNING cluster, renewed_at
  `;
  if (taken.length === 0) {
    // Another cluster made the first lease between the read and the insert.
    const [holder] = await db.$queryRaw<LeaseRow[]>`SELECT cluster, renewed_at FROM orchestrator_lease WHERE id = 1 FOR UPDATE`;
    return holder;
  }
  if (previous === undefined) {
    console.info(`the orchestrator lease was taken by ${cluster}`);
  } else if (previous.cluster !== cluster) {
    console.warn(`the orchestrator lease passed from ${previous.cluster} to ${cluster}, whose last claim was at ${previous.renewed_at.toISOString()}`);
  }
  return undefined;
}

/**
 * Moves to `cluster` every agent meant to be running whose StatefulSet is on another: its disk stays behind, so it
 * starts again on a fresh one. The generation is bumped so the claim that follows has work for it, and the token is
 * dropped, which shuts the old pod out at once and has the claim mint a new one. A running agent with no cluster
 * recorded is taken to be on the holder's, so it is adopted without a restart.
 */
async function takeOver(db: Database, cluster: string, now: Date): Promise<void> {
  const moved = await db.$queryRaw<{ id: string; owner_oid: string; from_cluster: string }[]>`
    WITH moving AS (
      SELECT id, cluster AS from_cluster
        FROM virtual_agent
       WHERE desired = 'running' AND cluster IS NOT NULL AND cluster <> ${cluster}
         FOR UPDATE SKIP LOCKED
    )
    UPDATE virtual_agent v
       SET cluster = ${cluster}, generation = v.generation + 1, status = 'provisioning',
           status_detail = 'moved from ' || moving.from_cluster || ' to ' || ${cluster} || '; starting on a fresh disk',
           status_changed_at = ${now}, launch_token_hash = NULL, launch_token_issued_at = NULL, claimed_by = NULL, claimed_at = NULL,
           updated_at = ${now}
      FROM moving
     WHERE v.id = moving.id
    RETURNING v.id::text AS id, v.owner_oid, moving.from_cluster
  `;
  for (const row of moved) {
    console.warn(`virtual agent ${row.id} moved from ${row.from_cluster} to ${cluster}, on a fresh disk`);
    await announce(db, row.id, row.owner_oid);
  }
  await db.$executeRaw`
    WITH unplaced AS (
      SELECT id FROM virtual_agent WHERE desired = 'running' AND cluster IS NULL FOR UPDATE SKIP LOCKED
    )
    UPDATE virtual_agent v SET cluster = ${cluster} FROM unplaced WHERE v.id = unplaced.id
  `;
}

/**
 * Only the holder of the orchestrator lease claims; any other cluster is told it is on standby. The holder first
 * takes over the running agents homed on another cluster, then claims up to `limit` agents it has work for: a spec it
 * has not applied, or a disk that has expired and not been deleted. A claim lasts `CLAIM_TIMEOUT_MS` unless reported
 * on, so a holder that restarts has its claims again. Every claimed agent's cluster becomes the caller's.
 *
 * A launch token is minted, replacing any before it, when the agent is meant to be running and either has none or is
 * starting a new pod. Its plain value goes in this response and nowhere else.
 */
export async function claimVirtualAgents(prisma: PrismaClient, cluster: string, options: ClaimOptions = {}): Promise<ClaimResult> {
  const { limit = CLAIM_LIMIT, now = new Date(), leaseSeconds = orchestratorLeaseSeconds() } = options;
  return await prisma.$transaction(async (tx) => {
    const holder = await takeLease(tx, cluster, now, leaseSeconds);
    if (holder !== undefined) {
      return { active: false, virtual_agents: [], lease: { cluster: holder.cluster, renewed_at: holder.renewed_at.toISOString() } };
    }
    await takeOver(tx, cluster, now);
    const rows = await tx.$queryRaw<ClaimRow[]>`
      WITH due AS (
        SELECT id
          FROM virtual_agent
         WHERE (generation > observed_generation OR (desired <> 'running' AND disk_expires_at <= ${now} AND disk_deleted_at IS NULL))
           AND (claimed_at IS NULL OR claimed_at <= ${new Date(now.getTime() - CLAIM_TIMEOUT_MS)})
         ORDER BY updated_at, id
         LIMIT ${limit}::int
           FOR UPDATE SKIP LOCKED
      )
      UPDATE virtual_agent v
         SET claimed_by = ${cluster}, claimed_at = ${now}, cluster = ${cluster}
        FROM due
       WHERE v.id = due.id
      RETURNING v.id::text AS id, v.generation, v.desired::text AS desired, v.status::text AS status, v.statefulset_name, v.pvc_name,
                v.model_route::text AS model_route, v.size::text AS size, v.exposed_ports, v.owner_oid, v.launch_token_hash IS NOT NULL AS has_token,
                COALESCE(v.desired <> 'running' AND v.disk_expires_at <= ${now} AND v.disk_deleted_at IS NULL, false) AS disk_due
    `;
    const claimed: ClaimedVirtualAgent[] = [];
    for (const row of rows) {
      let launchToken: string | undefined;
      if (row.desired === "running" && (!row.has_token || STARTING_FROM.includes(row.status))) {
        const minted = mintLaunchToken();
        await tx.virtualAgent.update({ where: { id: row.id }, data: { launchTokenHash: minted.hash, launchTokenIssuedAt: now } });
        launchToken = minted.token;
      }
      claimed.push({
        id: row.id,
        generation: row.generation,
        desired: row.desired,
        statefulset_name: row.statefulset_name,
        pvc_name: row.pvc_name,
        delete_disk: row.desired === "deleted" || row.disk_due,
        model_route: row.model_route,
        size: row.size,
        exposed_ports: row.exposed_ports,
        owner: { oid: row.owner_oid },
        ...(launchToken === undefined ? {} : { launch_token: launchToken })
      });
    }
    return { active: true, virtual_agents: claimed };
  });
}

export interface ObservedReport extends Omit<Observation, "source"> {
  generation: number;
}

export type ObserveResult = { removed: true } | { removed: false; row: VirtualAgentRow };

/**
 * The orchestrator's report on a claimed agent: which generation it applied, and what it saw. It releases the claim,
 * moves `observed_generation` forward (never back), and maps what was seen onto the status. An agent that has just
 * stopped starts its disk's expiry; a deleted agent whose StatefulSet and disk are both gone is removed.
 */
export async function observeVirtualAgent(prisma: PrismaClient, id: string, report: ObservedReport, now: Date = new Date()): Promise<ObserveResult> {
  return await prisma.$transaction(async (tx) => {
    const row = await lockVirtualAgent(tx, id);
    if (row === undefined) {
      throw new HttpError(404, "no such virtual agent");
    }
    if (report.generation > row.generation) {
      throw new HttpError(409, `generation ${report.generation} has not been asked for; the latest is ${row.generation}`);
    }
    const outcome = nextStatus(row, { source: "orchestrator", ...report });
    if ("remove" in outcome) {
      await tx.virtualAgent.delete({ where: { id } });
      await announce(tx, id, row.ownerOid);
      return { removed: true };
    }
    if ("refused" in outcome) {
      throw new HttpError(409, outcome.refused);
    }
    const nowStopped = outcome.status === "stopped" && row.status !== "stopped";
    const diskDeleted = report.diskDeleted === true && row.desired !== "running" && row.diskDeletedAt === null;
    const updated = toRow(
      await tx.virtualAgent.update({
        where: { id },
        data: {
          observedGeneration: Math.max(row.observedGeneration, report.generation),
          claimedBy: null,
          claimedAt: null,
          status: outcome.status,
          ...(outcome.detail === undefined ? {} : { statusDetail: outcome.detail }),
          ...(outcome.status === row.status ? {} : { statusChangedAt: now }),
          ...(nowStopped ? { stoppedAt: now, ...(row.diskDeletedAt === null ? { diskExpiresAt: diskExpiresAt(now, diskTtlDays()) } : {}) } : {}),
          ...(diskDeleted ? { diskDeletedAt: now } : {}),
          updatedAt: now
        },
        select: SELECT
      })
    );
    await announce(tx, id, row.ownerOid);
    return { removed: false, row: updated };
  });
}

export interface LiveVirtualAgent {
  id: string;
  statefulset_name: string;
  /** `null` once the disk has been deleted, so a PVC by that name is an orphan. */
  pvc_name: string | null;
  /** The cluster its StatefulSet is meant to be on, or `null` before any orchestrator has claimed it. */
  cluster: string | null;
}

/**
 * Every virtual agent the hub still has a row for, so anything else the orchestrator finds is an orphan. It needs no
 * lease: an orchestrator on standby reads it to delete what has moved away from its cluster.
 */
export async function liveVirtualAgents(db: Database): Promise<LiveVirtualAgent[]> {
  const rows = await db.virtualAgent.findMany({
    select: { id: true, statefulsetName: true, pvcName: true, diskDeletedAt: true, cluster: true },
    orderBy: { id: "asc" }
  });
  return rows.map((row) => ({
    id: row.id,
    statefulset_name: row.statefulsetName,
    pvc_name: row.diskDeletedAt === null ? row.pvcName : null,
    cluster: row.cluster
  }));
}
