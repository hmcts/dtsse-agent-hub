import type { PrismaClient } from "../store/prisma.ts";
import { type FeedbackBlobs, projectPrefix, recordingPrefix } from "./blob.ts";
import { ARCHIVED_PROJECT_DAYS, MAX_RECORDING_MS } from "./limits.ts";

/** Retention is in days, so a sweep every 10 minutes is far more often than anything becomes due. */
const FEEDBACK_SWEEP_INTERVAL_MS = 10 * 60_000;

/** Rows of each kind deleted per sweep, so a backlog drains over a few ticks rather than in one long transaction. */
const FEEDBACK_SWEEP_BATCH = 100;

/**
 * How long the sweep's transaction may run. Prisma's default is 5 seconds, and a batch deletes blobs over the network
 * while the lock is held.
 */
const FEEDBACK_SWEEP_TIMEOUT_MS = 5 * 60_000;

/** A recording still running this long after it started was abandoned: the tab closed, or the browser died. */
const ABANDONED_RECORDING_MS = MAX_RECORDING_MS + 60 * 60_000;

/** "fdbksweep". Distinct from every other sweep's lock and the migration's. */
const FEEDBACK_SWEEP_LOCK_KEY = 0x66646273_77657070n;

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
}

/**
 * Deletes what each feedback project keeps for no longer than its `retention_days` — recordings by when they started,
 * threads by when anything last happened on them — and every project archived for `archivedDays`. The blobs go first
 * and the rows after, so a blob delete that fails leaves the row to name the blobs for the next tick, rather than
 * orphaning them with no row to find them by. Then marks failed every recording that has been running for longer
 * than any may.
 *
 * The same transaction-scoped `pg_try_advisory_xact_lock` as the other sweeps, so one pod sweeps per tick.
 * `undefined` means another pod held the lock.
 */
export async function sweepFeedback(
  prisma: PrismaClient,
  blobs: Pick<FeedbackBlobs, "deleteBlob" | "deletePrefix">,
  options: FeedbackSweepOptions = {}
): Promise<FeedbackSweepResult | undefined> {
  const { batch = FEEDBACK_SWEEP_BATCH, archivedDays = ARCHIVED_PROJECT_DAYS, now = new Date() } = options;
  return await prisma.$transaction(
    async (tx) => {
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${FEEDBACK_SWEEP_LOCK_KEY}) AS locked`;
      if (lock?.locked !== true) {
        return undefined;
      }
      const archived = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM feedback_project
         WHERE archived_at < ${now}::timestamptz - make_interval(days => ${archivedDays}::int)
         ORDER BY archived_at, id
         LIMIT ${batch}::int`;
      for (const { id } of archived) {
        await blobs.deletePrefix(projectPrefix(id));
        await tx.feedbackProject.delete({ where: { id } });
      }
      const recordings = await tx.$queryRaw<{ id: string; project_id: string }[]>`
        SELECT r.id::text AS id, r.project_id::text AS project_id
          FROM feedback_recording r JOIN feedback_project p ON p.id = r.project_id
         WHERE r.started_at < ${now}::timestamptz - make_interval(days => p.retention_days)
         ORDER BY r.started_at, r.id
         LIMIT ${batch}::int`;
      for (const recording of recordings) {
        await blobs.deletePrefix(recordingPrefix(recording.project_id, recording.id));
        await tx.feedbackRecording.delete({ where: { id: recording.id } });
      }
      const threads = await tx.$queryRaw<{ id: string; snapshot_blob: string | null }[]>`
        SELECT t.id::text AS id, t.snapshot_blob
          FROM feedback_thread t JOIN feedback_project p ON p.id = t.project_id
         WHERE t.updated_at < ${now}::timestamptz - make_interval(days => p.retention_days)
         ORDER BY t.updated_at, t.id
         LIMIT ${batch}::int`;
      for (const thread of threads) {
        if (thread.snapshot_blob !== null) {
          await blobs.deleteBlob(thread.snapshot_blob);
        }
        await tx.feedbackThread.delete({ where: { id: thread.id } });
      }
      const abandoned = await tx.$executeRaw`
        UPDATE feedback_recording SET status = 'failed'
         WHERE status = 'recording' AND started_at < ${new Date(now.getTime() - ABANDONED_RECORDING_MS)}::timestamptz`;
      return { projects: archived.length, recordings: recordings.length, threads: threads.length, abandoned };
    },
    { timeout: FEEDBACK_SWEEP_TIMEOUT_MS, maxWait: 10_000 }
  );
}

export interface FeedbackSweeper {
  stop: () => Promise<void>;
}

/** Runs `sweepFeedback` on an interval, with the timer unreferenced as the other sweeps' are. */
export function startFeedbackSweep(
  prisma: PrismaClient,
  blobs: Pick<FeedbackBlobs, "deleteBlob" | "deletePrefix">,
  intervalMs: number = FEEDBACK_SWEEP_INTERVAL_MS
): FeedbackSweeper {
  let running = false;
  let tick: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    tick = sweepFeedback(prisma, blobs)
      .then((result) => {
        if (result !== undefined && result.projects + result.recordings + result.threads + result.abandoned > 0) {
          console.info(
            `feedback sweep: ${result.projects} archived projects, ${result.recordings} recordings and ${result.threads} threads deleted, ${result.abandoned} abandoned recordings failed`
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
