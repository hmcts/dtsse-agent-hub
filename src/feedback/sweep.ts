import type { PrismaClient } from "../store/prisma.ts";
import { type FeedbackBlobs, projectPrefix, recordingPrefix } from "./blob.ts";
import { ARCHIVED_PROJECT_DAYS, MAX_RECORDING_MS } from "./limits.ts";

/** Retention is in days, so a sweep every 10 minutes is far more often than anything becomes due. */
const FEEDBACK_SWEEP_INTERVAL_MS = 10 * 60_000;

/** Rows of each kind deleted per sweep, so a backlog drains over a few ticks. */
const FEEDBACK_SWEEP_BATCH = 100;

/**
 * How long the lock's transaction may stay open. Prisma's default is 5 seconds, and the blobs of a whole batch are
 * deleted over the network while it is held.
 */
const FEEDBACK_SWEEP_TIMEOUT_MS = 5 * 60_000;

/** Prefixes, each one listed and then deleted in batches, being deleted at once. */
const PREFIX_CONCURRENCY = 8;

/** A recording still running this long after it started was abandoned: the tab closed, or the browser died. */
const ABANDONED_RECORDING_MS = MAX_RECORDING_MS + 60 * 60_000;

/** "fdbksweep". Distinct from every other sweep's lock and the migration's. */
const FEEDBACK_SWEEP_LOCK_KEY = 0x66646273_77657070n;

export type FeedbackSweepBlobs = Pick<FeedbackBlobs, "deleteBlobs" | "deletePrefix">;

export interface FeedbackSweepOptions {
  batch?: number;
  archivedDays?: number;
  now?: Date;
}

export interface FeedbackSweepResult {
  /** Archived projects deleted whole. */
  projects: number;
  /** Recordings and threads deleted for being older than their project's retention. */
  recordings: number;
  threads: number;
  /** Recordings left running long past the longest a recording may be, marked failed. */
  abandoned: number;
  /** Rows kept because their blobs could not all be deleted, for the next tick to try again. */
  kept: number;
}

interface Step {
  deleted: number;
  kept: number;
}

/** `work` over `items`, no more than `limit` at once, answering each item's outcome in order. */
async function bounded<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await work(items[index] as T) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The ids of `rows` whose prefix was emptied, which are the rows that may now go. */
async function emptiedPrefixes<T extends { id: string }>(rows: readonly T[], blobs: FeedbackSweepBlobs, prefixOf: (row: T) => string): Promise<string[]> {
  const outcomes = await bounded(rows, PREFIX_CONCURRENCY, (row) => blobs.deletePrefix(prefixOf(row)));
  return rows.filter((_row, index) => outcomes[index]?.status === "fulfilled").map((row) => row.id);
}

async function sweepArchived(prisma: PrismaClient, blobs: FeedbackSweepBlobs, batch: number, archivedDays: number, now: Date): Promise<Step> {
  const cutoff = new Date(now.getTime() - archivedDays * 24 * 60 * 60_000);
  const rows = await prisma.feedbackProject.findMany({
    where: { archivedAt: { lt: cutoff } },
    select: { id: true },
    orderBy: [{ archivedAt: "asc" }, { id: "asc" }],
    take: batch
  });
  const ids = await emptiedPrefixes(rows, blobs, (row) => projectPrefix(row.id));
  const { count } = ids.length === 0 ? { count: 0 } : await prisma.feedbackProject.deleteMany({ where: { id: { in: ids }, archivedAt: { lt: cutoff } } });
  return { deleted: count, kept: rows.length - ids.length };
}

async function sweepRecordings(prisma: PrismaClient, blobs: FeedbackSweepBlobs, batch: number, now: Date): Promise<Step> {
  const rows = await prisma.$queryRaw<{ id: string; project_id: string }[]>`
    SELECT r.id::text AS id, r.project_id::text AS project_id
      FROM feedback_recording r JOIN feedback_project p ON p.id = r.project_id
     WHERE r.started_at < ${now}::timestamptz - make_interval(days => p.retention_days)
     ORDER BY r.started_at, r.id
     LIMIT ${batch}::int`;
  const ids = await emptiedPrefixes(rows, blobs, (row) => recordingPrefix(row.project_id, row.id));
  const { count } = ids.length === 0 ? { count: 0 } : await prisma.feedbackRecording.deleteMany({ where: { id: { in: ids } } });
  return { deleted: count, kept: rows.length - ids.length };
}

async function sweepThreads(prisma: PrismaClient, blobs: FeedbackSweepBlobs, batch: number, now: Date): Promise<Step> {
  const rows = await prisma.$queryRaw<{ id: string; snapshot_blob: string | null }[]>`
    SELECT t.id::text AS id, t.snapshot_blob
      FROM feedback_thread t JOIN feedback_project p ON p.id = t.project_id
     WHERE t.updated_at < ${now}::timestamptz - make_interval(days => p.retention_days)
     ORDER BY t.updated_at, t.id
     LIMIT ${batch}::int`;
  const failed = new Set(await blobs.deleteBlobs(rows.flatMap((row) => (row.snapshot_blob === null ? [] : [row.snapshot_blob]))));
  const ids = rows.filter((row) => row.snapshot_blob === null || !failed.has(row.snapshot_blob)).map((row) => row.id);
  // Still past retention: a reply since the read above keeps the thread, at the cost of its snapshot.
  const count =
    ids.length === 0
      ? 0
      : await prisma.$executeRaw`
          DELETE FROM feedback_thread t USING feedback_project p
           WHERE p.id = t.project_id AND t.id = ANY(${ids}::uuid[])
             AND t.updated_at < ${now}::timestamptz - make_interval(days => p.retention_days)`;
  return { deleted: count, kept: rows.length - ids.length };
}

/** Leaves out the recordings past retention, which `sweepRecordings` is deleting beside it. */
async function sweepAbandoned(prisma: PrismaClient, now: Date): Promise<Step> {
  const count = await prisma.$executeRaw`
    UPDATE feedback_recording r SET status = 'failed'
      FROM feedback_project p
     WHERE p.id = r.project_id AND r.status = 'recording'
       AND r.started_at < ${new Date(now.getTime() - ABANDONED_RECORDING_MS)}::timestamptz
       AND r.started_at >= ${now}::timestamptz - make_interval(days => p.retention_days)`;
  return { deleted: count, kept: 0 };
}

/**
 * Deletes what each feedback project keeps for no longer than its `retention_days` — recordings by when they started,
 * threads by when anything last happened on them — and every project archived for `archivedDays`. Then marks failed
 * every recording that has been running for longer than any may.
 *
 * Each kind is a step of its own, run side by side, so a slow or failing one holds none of the others back: it reads a
 * batch of rows, deletes their blobs outside any transaction, then deletes the rows whose blobs went, each in one
 * statement. A row whose blobs could not all be deleted is kept to name them for the next tick, rather than leaving
 * them with no row to find them by.
 *
 * One pod sweeps per tick, under the same transaction-scoped `pg_try_advisory_xact_lock` as the other sweeps: the
 * transaction takes the lock and holds it, doing nothing else, while the steps run on connections of their own, so no
 * blob delete runs inside a transaction that has written anything. `undefined` means another pod held the lock.
 * After the first statement the open transaction holds no snapshot, so it keeps nothing from being vacuumed.
 */
export async function sweepFeedback(
  prisma: PrismaClient,
  blobs: FeedbackSweepBlobs,
  options: FeedbackSweepOptions = {}
): Promise<FeedbackSweepResult | undefined> {
  const { batch = FEEDBACK_SWEEP_BATCH, archivedDays = ARCHIVED_PROJECT_DAYS, now = new Date() } = options;
  return await prisma.$transaction(
    async (tx) => {
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${FEEDBACK_SWEEP_LOCK_KEY}) AS locked`;
      if (lock?.locked !== true) {
        return undefined;
      }
      const steps = await Promise.allSettled([
        sweepArchived(prisma, blobs, batch, archivedDays, now),
        sweepRecordings(prisma, blobs, batch, now),
        sweepThreads(prisma, blobs, batch, now),
        sweepAbandoned(prisma, now)
      ]);
      const failure = steps.find((step) => step.status === "rejected");
      if (failure !== undefined) {
        throw failure.reason;
      }
      const [projects, recordings, threads, abandoned] = steps.map((step) => (step as PromiseFulfilledResult<Step>).value) as [Step, Step, Step, Step];
      return {
        projects: projects.deleted,
        recordings: recordings.deleted,
        threads: threads.deleted,
        abandoned: abandoned.deleted,
        kept: projects.kept + recordings.kept + threads.kept
      };
    },
    { timeout: FEEDBACK_SWEEP_TIMEOUT_MS, maxWait: 10_000 }
  );
}

export interface FeedbackSweeper {
  stop: () => Promise<void>;
}

/** Runs `sweepFeedback` on an interval, with the timer unreferenced as the other sweeps' are. */
export function startFeedbackSweep(prisma: PrismaClient, blobs: FeedbackSweepBlobs, intervalMs: number = FEEDBACK_SWEEP_INTERVAL_MS): FeedbackSweeper {
  let running = false;
  let tick: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    tick = sweepFeedback(prisma, blobs)
      .then((result) => {
        if (result !== undefined && result.projects + result.recordings + result.threads + result.abandoned + result.kept > 0) {
          console.info(
            `feedback sweep: ${result.projects} archived projects, ${result.recordings} recordings and ${result.threads} threads deleted, ${result.abandoned} abandoned recordings failed, ${result.kept} kept because their blobs could not be deleted`
          );
        }
      })
      .catch((error: unknown) => {
        console.warn(`the feedback sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  // Waits for the tick in flight, whose transaction is still holding locks the caller's next statement may want.
  return {
    stop: async () => {
      clearInterval(timer);
      await tick;
    }
  };
}
