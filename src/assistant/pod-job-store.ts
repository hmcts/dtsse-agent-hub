import { canReadPodJob, canRequestPodJob } from "../access/rules.ts";
import { HttpError } from "../agent-api/http.ts";
import { podReady } from "../agents/pod-ready.ts";
import { isUuid } from "../agents/store.ts";
import { notify } from "../realtime/notify.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { findAssistantWithClaims } from "./assistant-store.ts";
import { POD_JOB_REGISTRY } from "./pod-job-kinds.ts";
import {
  checkPodJobAnswer,
  checkPodJobArgs,
  checkPodJobResult,
  keptPodJobsSince,
  type PodJobKind,
  type PodJobRequest,
  type PodJobView,
  podJobFeature,
  podJobStatus,
  podJobView
} from "./pod-jobs.ts";
import { accessToConversation } from "./shares.ts";

/**
 * A pod job as the hub keeps it: recorded when the owner's panel asks, sent to the conversation's pod on its sessions
 * stream, answered by the pod, and read back by the panel. See "Pod jobs" in docs/agent-api.md.
 *
 * A row is pending until the pod answers or its `expires_at` passes, after which it reads as `timeout` whatever it
 * still says and a late answer is ignored. The sweep writes that down and deletes jobs older than `POD_JOB_KEEP_MS`;
 * nothing relies on it having run, since every read checks the clock itself.
 */

function kindOf(kind: unknown): PodJobKind {
  const definition = typeof kind === "string" ? POD_JOB_REGISTRY.get(kind) : undefined;
  if (definition === undefined) {
    throw new HttpError(400, "kind: there is no such job");
  }
  return definition;
}

/**
 * Asks the conversation's pod to run a job of `kind`, for its owner alone (`canRequestPodJob`): a reader is refused,
 * anyone else finds nothing. Nothing is recorded when the conversation is a local session's, when its assistant has
 * been replaced, or when the pod cannot be asked now or has no handler for the kind. A one-at-a-time kind joins the
 * conversation's pending job when the arguments are the same, and is refused with 409 when they are not.
 */
export async function requestPodJob(
  prisma: PrismaClient,
  viewerOid: string,
  conversationId: string,
  request: { kind: unknown; args: unknown },
  now: Date = new Date()
): Promise<PodJobRequest> {
  const definition = kindOf(request.kind);
  const args = checkPodJobArgs(definition, request.args);
  const allowed = await accessToConversation(prisma, viewerOid, conversationId);
  if (allowed === undefined) {
    throw new HttpError(404, "that chat is not there");
  }
  if (!canRequestPodJob(allowed.access)) {
    throw new HttpError(403, "only the person whose chat this is can run that on their assistant");
  }
  const { conversation } = allowed;
  // A local session's conversation has no pod, and never will.
  if (conversation.virtualAgentId === null) {
    return { status: "no_pod" };
  }
  const found = await findAssistantWithClaims(prisma, viewerOid);
  if (found === undefined || found.assistant.id !== conversation.virtualAgentId) {
    return { status: "assistant_gone" };
  }
  const ready = await podReady(prisma, viewerOid, found, podJobFeature(definition.kind), now);
  if (ready !== "ok") {
    return { status: ready };
  }
  const virtualAgentId = found.assistant.id;
  const id = await prisma.$transaction(async (tx) => {
    // The assistant's rows are taken one request at a time, so two tabs can neither both find room under the limit
    // nor both start a one-at-a-time job.
    await tx.$queryRaw`SELECT 1 FROM virtual_agent WHERE id = ${virtualAgentId}::uuid FOR UPDATE`;
    if (definition.oneAtATime) {
      // Written down first, so the partial unique index lets a new job start once the old one ran out of time.
      await tx.assistantPodJob.updateMany({
        where: { conversationId, kind: definition.kind, status: "pending", expiresAt: { lte: now } },
        data: { status: "timeout", finishedAt: now }
      });
      const running = await tx.assistantPodJob.findFirst({
        where: { conversationId, kind: definition.kind, status: "pending", exclusive: true },
        select: { id: true }
      });
      if (running !== null) {
        const same = await tx.assistantPodJob.count({ where: { id: running.id, args: { equals: args as object } } });
        if (same === 0) {
          throw new HttpError(409, "that is already running in this chat; wait for it to finish", { job_id: running.id });
        }
        return running.id;
      }
    }
    const recent = await tx.assistantPodJob.count({
      where: { ownerOid: viewerOid, kind: definition.kind, createdAt: { gte: new Date(now.getTime() - definition.rateLimit.windowMs) } }
    });
    if (recent >= definition.rateLimit.limit) {
      throw new HttpError(429, "that is a lot at once; wait a moment and try again");
    }
    const row = await tx.assistantPodJob.create({
      data: {
        conversationId,
        ownerOid: viewerOid,
        virtualAgentId,
        kind: definition.kind,
        args: args as object,
        exclusive: definition.oneAtATime,
        createdAt: now,
        expiresAt: new Date(now.getTime() + definition.timeoutMs)
      },
      select: { id: true }
    });
    await notify(tx, { type: "assistant_pod_job_requested", job_id: row.id, virtual_agent_id: virtualAgentId, owner_oid: viewerOid });
    return row.id;
  });
  return { status: "pending", job_id: id };
}

/** One of the viewer's own jobs in this conversation as it stands now; anybody else's, or one swept, is not found. */
export async function readPodJob(
  db: Database,
  viewerOid: string,
  conversationId: string,
  jobId: string,
  now: Date = new Date()
): Promise<PodJobView | undefined> {
  if (!isUuid(jobId) || !isUuid(conversationId)) {
    return undefined;
  }
  const row = await db.assistantPodJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      conversationId: true,
      ownerOid: true,
      kind: true,
      status: true,
      result: true,
      error: true,
      detail: true,
      createdAt: true,
      expiresAt: true
    }
  });
  if (row === null || row.conversationId !== conversationId || !canReadPodJob(viewerOid, row) || row.createdAt < keptPodJobsSince(now)) {
    return undefined;
  }
  return podJobView(row, now);
}

/** What the sessions stream sends the pod for one job. */
export interface PodJobFrame {
  job_id: string;
  kind: string;
  conversation_id: string;
  /** The conversation's current session agent, for a handler that writes back through the agent API. */
  agent_id?: string;
  args: unknown;
}

const PENDING_ROW = {
  id: true,
  kind: true,
  conversationId: true,
  ownerOid: true,
  virtualAgentId: true,
  args: true,
  status: true,
  expiresAt: true,
  conversation: { select: { virtualAgentId: true, ownerOid: true, agentId: true } }
} as const;

type PendingRow = {
  id: string;
  kind: string;
  conversationId: string;
  ownerOid: string;
  virtualAgentId: string;
  args: unknown;
  status: string;
  expiresAt: Date;
  conversation: { virtualAgentId: string | null; ownerOid: string; agentId: string | null };
};

/** Whether `row` is a job of this virtual agent's still waiting for its answer, in a conversation still on it. */
const isPendingOn = (row: PendingRow, virtualAgentId: string, now: Date): boolean =>
  row.virtualAgentId === virtualAgentId &&
  row.conversation.virtualAgentId === virtualAgentId &&
  row.conversation.ownerOid === row.ownerOid &&
  podJobStatus(row, now) === "pending";

async function pendingRow(db: Database, virtualAgentId: string, jobId: string, now: Date): Promise<PendingRow | undefined> {
  if (!isUuid(jobId)) {
    return undefined;
  }
  const row = await db.assistantPodJob.findUnique({ where: { id: jobId }, select: PENDING_ROW });
  return row !== null && isPendingOn(row, virtualAgentId, now) ? row : undefined;
}

function frameOf(row: PendingRow): PodJobFrame {
  return {
    job_id: row.id,
    kind: row.kind,
    conversation_id: row.conversationId,
    ...(row.conversation.agentId === null ? {} : { agent_id: row.conversation.agentId }),
    args: row.args
  };
}

export async function pendingPodJobFrame(db: Database, virtualAgentId: string, jobId: string, now: Date = new Date()): Promise<PodJobFrame | undefined> {
  const row = await pendingRow(db, virtualAgentId, jobId, now);
  return row === undefined ? undefined : frameOf(row);
}

/** At most this many pending jobs are sent again on a stream's open; the rate limits keep the real number far under it. */
const MAX_REPLAYED_POD_JOBS = 200;

/**
 * Every job of this virtual agent's still pending, oldest first, for the sessions stream to send again as it opens: a
 * frame is sent once per stream, so a job recorded while no stream was open, or whose frame a reconnect lost, would
 * otherwise wait out its timeout. The pod ignores a job it is already running or has answered.
 */
export async function pendingPodJobFrames(db: Database, virtualAgentId: string, now: Date = new Date()): Promise<PodJobFrame[]> {
  const rows = await db.assistantPodJob.findMany({
    where: { virtualAgentId, status: "pending", expiresAt: { gt: now }, conversation: { virtualAgentId } },
    select: PENDING_ROW,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: MAX_REPLAYED_POD_JOBS
  });
  return rows.filter((row) => isPendingOn(row, virtualAgentId, now)).map(frameOf);
}

/** A pending job of this virtual agent's that its pod may answer, read once for both the body's cap and the answer. */
export interface AnswerablePodJob {
  id: string;
  conversationId: string;
  ownerOid: string;
  virtualAgentId: string;
  definition: PodJobKind;
}

/**
 * The job the pod is answering, or `undefined` when there is no pending job of its to answer, so the route reads
 * nothing it would ignore anyway. A kind this hub no longer registers is left to time out: there is nothing to check
 * its answer against.
 */
export async function answerablePodJob(db: Database, virtualAgentId: string, jobId: string, now: Date = new Date()): Promise<AnswerablePodJob | undefined> {
  const row = await pendingRow(db, virtualAgentId, jobId, now);
  const definition = row === undefined ? undefined : POD_JOB_REGISTRY.get(row.kind);
  if (row === undefined || definition === undefined) {
    return undefined;
  }
  return { id: row.id, conversationId: row.conversationId, ownerOid: row.ownerOid, virtualAgentId, definition };
}

/**
 * The pod's answer to a job `answerablePodJob` found, kept only while it is still pending, inside its time and in a
 * conversation still on this virtual agent, each checked again in the update itself, so a late or repeated answer, or
 * one racing the conversation's move to another assistant, changes nothing. An answer the kind does not allow is a 400; keeping it tells the owner's
 * open tabs (`assistant_pod_job`).
 */
export async function answerPodJob(prisma: PrismaClient, job: AnswerablePodJob, body: unknown, now: Date = new Date()): Promise<void> {
  const answer = checkPodJobAnswer(job.definition, body);
  const data =
    answer.status === "done"
      ? { status: "done", result: answer.result as object, finishedAt: now }
      : { status: "failed", error: answer.error, detail: answer.detail ?? null, finishedAt: now };
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.assistantPodJob.updateMany({
      where: {
        id: job.id,
        virtualAgentId: job.virtualAgentId,
        status: "pending",
        expiresAt: { gt: now },
        conversation: { virtualAgentId: job.virtualAgentId }
      },
      data
    });
    if (count > 0) {
      await notify(tx, { type: "assistant_pod_job", job_id: job.id, conversation_id: job.conversationId, owner_oid: job.ownerOid });
    }
  });
}

/** A pending job, locked for the rest of the caller's transaction. */
export interface LockedPodJob {
  id: string;
  kind: string;
  conversationId: string;
  ownerOid: string;
  virtualAgentId: string;
  args: unknown;
}

/**
 * Locks a pending job of `kind` for the caller's transaction, for a feature whose success is a write of its own
 * rather than a result: it binds that write to the job, and then `finishPodJob` marks the job done in the same
 * transaction, so the write and the job's end commit together or not at all. `undefined` for a job that is not
 * pending, not of `kind`, or past its time.
 */
export async function lockPendingPodJob(tx: Database, jobId: string, kind: string, now: Date = new Date()): Promise<LockedPodJob | undefined> {
  if (!isUuid(jobId)) {
    return undefined;
  }
  const [row] = await tx.$queryRaw<LockedPodJob[]>`
    SELECT id::text AS "id", kind, conversation_id::text AS "conversationId", owner_oid AS "ownerOid",
           virtual_agent_id::text AS "virtualAgentId", args
      FROM assistant_pod_job
     WHERE id = ${jobId}::uuid AND kind = ${kind} AND status = 'pending' AND expires_at > ${now}
       FOR UPDATE
  `;
  return row;
}

/**
 * Marks a job `lockPendingPodJob` locked as done with `result`, checked against its kind, and tells the owner's open
 * tabs on commit. `false` when the job is no longer pending, which a caller holding the lock never sees.
 */
export async function finishPodJob(tx: Database, job: LockedPodJob, result: unknown, now: Date = new Date()): Promise<boolean> {
  const definition = POD_JOB_REGISTRY.get(job.kind);
  if (definition === undefined) {
    throw new Error(`pod job kind ${job.kind} is not registered`);
  }
  const checked = checkPodJobResult(definition, result);
  const { count } = await tx.assistantPodJob.updateMany({
    where: { id: job.id, status: "pending" },
    data: { status: "done", result: checked as object, finishedAt: now }
  });
  if (count === 0) {
    return false;
  }
  await notify(tx, { type: "assistant_pod_job", job_id: job.id, conversation_id: job.conversationId, owner_oid: job.ownerOid });
  return true;
}

/** "podjobsw". Distinct from every other sweep's lock. */
const POD_JOB_SWEEP_LOCK_KEY = 0x706f646a_6f627377n;
const POD_JOB_SWEEP_INTERVAL_MS = 10 * 60_000;

/**
 * Writes down the jobs that ran out of time and deletes those older than `POD_JOB_KEEP_MS`. The same
 * transaction-scoped advisory lock as the other sweeps, so one pod sweeps per tick; `undefined` means another held it.
 */
export async function sweepPodJobs(prisma: PrismaClient, now: Date = new Date()): Promise<{ timedOut: number; deleted: number } | undefined> {
  return await prisma.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${POD_JOB_SWEEP_LOCK_KEY}) AS locked`;
    if (lock?.locked !== true) {
      return undefined;
    }
    const { count: timedOut } = await tx.assistantPodJob.updateMany({
      where: { status: "pending", expiresAt: { lte: now } },
      data: { status: "timeout", finishedAt: now }
    });
    const { count: deleted } = await tx.assistantPodJob.deleteMany({ where: { createdAt: { lt: keptPodJobsSince(now) } } });
    return { timedOut, deleted };
  });
}

/** Runs `sweepPodJobs` on an interval, unreferenced, as the other sweeps are. */
export function startPodJobSweep(prisma: PrismaClient, intervalMs: number = POD_JOB_SWEEP_INTERVAL_MS): { stop: () => Promise<void> } {
  let tick: Promise<void> = Promise.resolve();
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    tick = sweepPodJobs(prisma)
      .then(() => undefined)
      .catch((error: unknown) => console.warn(`the pod job sweep failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return {
    stop: async () => {
      clearInterval(timer);
      await tick;
    }
  };
}
