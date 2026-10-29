import { canUseWelsh } from "../access/rules.ts";
import { HttpError } from "../agent-api/http.ts";
import { clientSupports } from "../agents/client-features.ts";
import { isUuid } from "../agents/store.ts";
import type { EventHub } from "../realtime/hub.ts";
import { notify } from "../realtime/notify.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { setDesired } from "../virtual-agents/store.ts";
import { findAssistant } from "./store.ts";
import {
  fileIdsOf,
  MAX_WELSH_FILE_BYTES,
  MAX_WELSH_FILES_PER_JOB,
  resultFits,
  WELSH_RATE_LIMIT,
  WELSH_RATE_WINDOW_MS,
  WELSH_RETENTION_MS,
  type WelshAnswer,
  type WelshArgs,
  type WelshFileView,
  type WelshKind,
  type WelshResponse,
  welshResponse
} from "./welsh.ts";

/**
 * A Welsh translation job as the hub keeps it: recorded when the owner starts it, sent to their pod on its sessions
 * stream, answered by the pod with what `scripts/welsh` printed and any spreadsheets it made, and read back by the
 * page. See "Welsh translation jobs" in docs/agent-api.md.
 */

export interface WelshQuestion {
  viewerOid: string;
  kind: WelshKind;
  product: string;
  args: WelshArgs;
}

/** The job to read back, or what to answer straight away because the pod cannot be asked. */
export type AskedWelsh = { jobId: string; virtualAgentId: string } | { answer: WelshResponse };

/**
 * Records the job for the viewer's own assistant and tells its pod. A stopped assistant is started rather than asked,
 * and a pod whose client cannot run jobs is not sent a frame nobody would read. Files a job reads must be the viewer's.
 */
export async function askWelsh(prisma: PrismaClient, question: WelshQuestion, now: Date = new Date()): Promise<AskedWelsh> {
  const assistant = await findAssistant(prisma, question.viewerOid);
  if (assistant === undefined || !canUseWelsh(question.viewerOid, assistant)) {
    throw new HttpError(404, "you have no assistant to run that with yet");
  }
  const files = await Promise.all(
    fileIdsOf(question.args).map((id) => prisma.assistantWelshFile.findUnique({ where: { id }, select: { ownerOid: true, jobId: true } }))
  );
  if (files.some((file) => file === null || file.ownerOid !== question.viewerOid || file.jobId !== null)) {
    throw new HttpError(404, "that spreadsheet is not there any more; upload it again");
  }
  if (assistant.desired === "stopped") {
    await setDesired(prisma, question.viewerOid, assistant.id, "running", now);
    return { answer: { status: "waking" } };
  }
  if (assistant.status !== "running" || assistant.agentId === null) {
    return { answer: { status: "waking" } };
  }
  const current = await prisma.agent.findUnique({ where: { id: assistant.agentId }, select: { clientFeatures: true } });
  if (!clientSupports(current?.clientFeatures, "welsh")) {
    return { answer: { status: "unsupported" } };
  }
  const id = await prisma.$transaction(async (tx) => {
    // The assistant's rows are taken one job at a time, so two tabs cannot both find room under the limit.
    await tx.$queryRaw`SELECT 1 FROM virtual_agent WHERE id = ${assistant.id}::uuid FOR UPDATE`;
    const old = new Date(now.getTime() - WELSH_RETENTION_MS);
    await tx.assistantWelshJob.deleteMany({ where: { virtualAgentId: assistant.id, createdAt: { lt: old } } });
    await tx.assistantWelshFile.deleteMany({ where: { virtualAgentId: assistant.id, createdAt: { lt: old } } });
    const recent = await tx.assistantWelshJob.count({
      where: { virtualAgentId: assistant.id, createdAt: { gte: new Date(now.getTime() - WELSH_RATE_WINDOW_MS) } }
    });
    if (recent >= WELSH_RATE_LIMIT) {
      throw new HttpError(429, "that is a lot at once; wait a moment and try again");
    }
    const row = await tx.assistantWelshJob.create({
      data: { virtualAgentId: assistant.id, kind: question.kind, product: question.product, args: question.args as object, createdAt: now },
      select: { id: true }
    });
    await notify(tx, { type: "assistant_welsh", job_id: row.id, virtual_agent_id: assistant.id, owner_oid: question.viewerOid });
    return row.id;
  });
  return { jobId: id, virtualAgentId: assistant.id };
}

/** What one of the viewer's jobs answers now. Anybody else's job, or one that has gone, is not found. */
export async function readWelsh(db: Database, viewerOid: string, jobId: string, now: Date = new Date()): Promise<WelshResponse | undefined> {
  if (!isUuid(jobId)) {
    return undefined;
  }
  const row = await db.assistantWelshJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      kind: true,
      status: true,
      result: true,
      error: true,
      detail: true,
      createdAt: true,
      virtualAgent: { select: { ownerOid: true } },
      files: { select: { id: true, name: true, createdAt: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }
    }
  });
  if (row === null || !canUseWelsh(viewerOid, row.virtualAgent)) {
    return undefined;
  }
  const sizes = row.files.length
    ? await db.$queryRaw<
        { id: string; bytes: number }[]
      >`SELECT id::text AS id, octet_length(bytes) AS bytes FROM assistant_welsh_file WHERE job_id = ${jobId}::uuid`
    : [];
  const files: WelshFileView[] = row.files.map((file) => ({
    file_id: file.id,
    name: file.name,
    bytes: Number(sizes.find((s) => s.id === file.id)?.bytes ?? 0)
  }));
  return welshResponse(row, files, now);
}

/**
 * Waits for the pod's answer to a quick job: on its NOTIFY, and on a slow poll as well, since a NOTIFY sent while this
 * pod's listener was reconnecting is gone. Subscribed before the first read, so an answer committed in between is not
 * missed. A job still pending when the wait ends answers `pending`, so the page reads it back as it does a long job:
 * a slow pod is late, not lost.
 */
export async function waitForWelsh(
  db: Database,
  hub: EventHub,
  viewerOid: string,
  jobId: string,
  { timeoutMs, pollMs = 1000, signal }: { timeoutMs: number; pollMs?: number; signal?: AbortSignal }
): Promise<WelshResponse> {
  return await new Promise<WelshResponse>((resolve) => {
    let done = false;
    let reading = false;
    const finish = (answer: WelshResponse) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        unsubscribe();
        signal?.removeEventListener("abort", aborted);
        resolve(answer);
      }
    };
    const check = async (): Promise<void> => {
      if (done || reading) {
        return;
      }
      reading = true;
      try {
        const answer = await readWelsh(db, viewerOid, jobId);
        if (answer === undefined) {
          finish({ status: "timeout" });
        } else if (answer.status !== "pending") {
          finish(answer);
        }
      } catch {
        // A failed read is tried again on the next poll; the timeout bounds it.
      } finally {
        reading = false;
      }
    };
    const aborted = () => finish({ status: "timeout" });
    const unsubscribe = hub.subscribe((event) => {
      if ((event.type === "assistant_welsh_answered" && event.job_id === jobId) || event.type === "resync") {
        void check();
      }
    });
    const timer = setTimeout(() => finish({ status: "pending", job_id: jobId }), timeoutMs);
    const poll = setInterval(() => void check(), pollMs);
    signal?.addEventListener("abort", aborted, { once: true });
    void check();
  });
}

/**
 * The pod's answer, kept only for one of its own jobs that is still pending, so a late or repeated answer, or one for
 * another assistant's job, changes nothing. A result too large to keep is stored as a failure saying so.
 */
export async function answerWelsh(
  prisma: PrismaClient,
  virtualAgent: { id: string; ownerOid: string },
  jobId: string,
  answer: WelshAnswer,
  now: Date = new Date()
): Promise<void> {
  if (!isUuid(jobId)) {
    return;
  }
  let data: { status: string; result?: object; error?: string; detail?: string | null; answeredAt: Date };
  if ("result" in answer) {
    data = resultFits(answer.result)
      ? { status: "done", result: answer.result, answeredAt: now }
      : { status: "failed", error: "failed", detail: "That was too much to show here. Try a narrower search or one repo at a time.", answeredAt: now };
  } else {
    data = { status: "failed", error: answer.error, detail: answer.detail ?? null, answeredAt: now };
  }
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.assistantWelshJob.updateMany({ where: { id: jobId, virtualAgentId: virtualAgent.id, status: "pending" }, data });
    if (count > 0) {
      await notify(tx, { type: "assistant_welsh_answered", job_id: jobId, virtual_agent_id: virtualAgent.id, owner_oid: virtualAgent.ownerOid });
    }
  });
}

/** A spreadsheet a pending job of this virtual agent's made, kept for its owner to download. */
export async function putJobFile(
  prisma: PrismaClient,
  virtualAgent: { id: string; ownerOid: string },
  jobId: string,
  name: string,
  bytes: Uint8Array
): Promise<string> {
  if (!isUuid(jobId)) {
    throw new HttpError(404, "no such job");
  }
  if (bytes.length === 0 || bytes.length > MAX_WELSH_FILE_BYTES) {
    throw new HttpError(413, "a file must be between 1 byte and 5 MiB");
  }
  return await prisma.$transaction(async (tx) => {
    const job = await tx.assistantWelshJob.findUnique({ where: { id: jobId }, select: { virtualAgentId: true, status: true } });
    if (job === null || job.virtualAgentId !== virtualAgent.id || job.status !== "pending") {
      throw new HttpError(404, "no such job waiting for an answer");
    }
    if ((await tx.assistantWelshFile.count({ where: { jobId } })) >= MAX_WELSH_FILES_PER_JOB) {
      throw new HttpError(409, "that job already has as many files as it may");
    }
    const row = await tx.assistantWelshFile.create({
      data: { virtualAgentId: virtualAgent.id, ownerOid: virtualAgent.ownerOid, jobId, name, bytes: Buffer.from(bytes) },
      select: { id: true }
    });
    return row.id;
  });
}

/** A spreadsheet the viewer uploaded for a job to read: a Welsh Language Unit return. */
export async function saveUpload(prisma: PrismaClient, viewerOid: string, name: string, bytes: Uint8Array, now: Date = new Date()): Promise<string> {
  const assistant = await findAssistant(prisma, viewerOid);
  if (assistant === undefined || !canUseWelsh(viewerOid, assistant)) {
    throw new HttpError(404, "you have no assistant to run that with yet");
  }
  if (bytes.length === 0 || bytes.length > MAX_WELSH_FILE_BYTES) {
    throw new HttpError(413, "that spreadsheet is over 5 MB");
  }
  const row = await prisma.assistantWelshFile.create({
    data: { virtualAgentId: assistant.id, ownerOid: viewerOid, name, bytes: Buffer.from(bytes), createdAt: now },
    select: { id: true }
  });
  return row.id;
}

/** One of the viewer's own Welsh files, uploaded or made by one of their jobs, or `undefined`. */
export async function ownerFile(db: Database, viewerOid: string, fileId: string): Promise<{ name: string; bytes: Uint8Array } | undefined> {
  if (!isUuid(fileId)) {
    return undefined;
  }
  const row = await db.assistantWelshFile.findUnique({ where: { id: fileId }, select: { ownerOid: true, name: true, bytes: true } });
  return row === null || row.ownerOid !== viewerOid ? undefined : { name: row.name, bytes: row.bytes };
}

/** A file the owner uploaded, for their own pod to read before it runs a job; nothing a job made, and nobody else's. */
export async function podFile(
  db: Database,
  virtualAgent: { id: string; ownerOid: string },
  fileId: string
): Promise<{ name: string; bytes: Uint8Array } | undefined> {
  if (!isUuid(fileId)) {
    return undefined;
  }
  const row = await db.assistantWelshFile.findUnique({ where: { id: fileId }, select: { ownerOid: true, jobId: true, name: true, bytes: true } });
  return row === null || row.ownerOid !== virtualAgent.ownerOid || row.jobId !== null ? undefined : { name: row.name, bytes: row.bytes };
}

/** What the sessions stream sends the pod for one job. */
export interface WelshFrame {
  job_id: string;
  kind: string;
  product: string;
  args: unknown;
  /** The uploaded file's name when `args.file_id` names one: the batch a return is recorded under. */
  file_name?: string;
}

/** The frame for a job of this virtual agent's still waiting for an answer, or `undefined`. */
export async function pendingWelsh(db: Database, virtualAgentId: string, jobId: string): Promise<WelshFrame | undefined> {
  const row = await db.assistantWelshJob.findUnique({
    where: { id: jobId },
    select: { virtualAgentId: true, kind: true, product: true, args: true, status: true }
  });
  if (row === null || row.virtualAgentId !== virtualAgentId || row.status !== "pending") {
    return undefined;
  }
  const fileId = (row.args as { file_id?: unknown } | null)?.file_id;
  const file = typeof fileId === "string" && isUuid(fileId) ? await db.assistantWelshFile.findUnique({ where: { id: fileId }, select: { name: true } }) : null;
  return { job_id: jobId, kind: row.kind, product: row.product, args: row.args, ...(file === null ? {} : { file_name: file.name }) };
}
