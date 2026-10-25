import type { PrismaClient } from "../store/prisma.ts";

/**
 * The backstop that stops Postgres filling with upload bytes.
 *
 * Normally a pod reports an attachment fetched within seconds of the message and `reportFetched` deletes its parts.
 * This covers the cases where that never happens: a pod that could not start, a browser that uploaded and then closed
 * the tab, and a fetched-report path that is broken. Without it, nothing complains while the database grows by 25 MB
 * an upload, which is why this has a test of its own.
 *
 * Only the parts go. The metadata row stays, marked `expired`, so the thread can still say a file was attached.
 */

/** Uploads are swept at about the rate the transcripts are, for the same reason: they grow slowly. */
export const UPLOAD_SWEEP_INTERVAL_MS = 10 * 60_000;

/** How long an upload nobody fetched keeps its bytes. Long enough for a stopped pod to be started and catch up. */
export const UPLOAD_RETENTION_HOURS = 3;

/** Uploads expired per sweep. Small, because each one is up to 25 MB of part rows in one transaction. */
export const UPLOAD_SWEEP_BATCH = 20;

/** "upldswep". Distinct from the migration, offline-sweep and transcript-sweep locks. */
const UPLOAD_SWEEP_LOCK_KEY = 0x75706c64_73776570n;

export interface UploadSweepOptions {
  retentionHours?: number;
  batch?: number;
}

export interface UploadSweepResult {
  /** Uploads marked `expired`. */
  expired: number;
  /** Part rows deleted with them. */
  parts: number;
}

/**
 * Deletes the parts of a batch of the uploads that nobody fetched within `retentionHours`, and marks those uploads
 * `expired`. Nothing is announced: a page showing the chip keeps it, which is right — the file was attached.
 *
 * The same transaction-scoped `pg_try_advisory_xact_lock` as the other sweeps, so one pod sweeps per tick.
 * `undefined` means another pod held the lock.
 */
export async function sweepUploads(prisma: PrismaClient, options: UploadSweepOptions = {}): Promise<UploadSweepResult | undefined> {
  const { retentionHours = UPLOAD_RETENTION_HOURS, batch = UPLOAD_SWEEP_BATCH } = options;
  return await prisma.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${UPLOAD_SWEEP_LOCK_KEY}) AS locked`;
    if (lock?.locked !== true) {
      return undefined;
    }
    const stale = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id
        FROM assistant_upload
       WHERE state IN ('pending', 'stored')
         AND created_at < now() - make_interval(hours => ${retentionHours}::int)
       ORDER BY created_at
       LIMIT ${batch}::int
    `;
    const ids = stale.map((row) => row.id);
    if (ids.length === 0) {
      return { expired: 0, parts: 0 };
    }
    const parts = await tx.assistantUploadPart.deleteMany({ where: { uploadId: { in: ids } } });
    const expired = await tx.assistantUpload.updateMany({ where: { id: { in: ids } }, data: { state: "expired", updatedAt: new Date() } });
    return { expired: expired.count, parts: parts.count };
  });
}

export interface UploadSweeper {
  stop: () => void;
}

/**
 * Runs `sweepUploads` on an interval, with the timer unreferenced as the other sweeps' are. Started whatever
 * `ASSISTANT_UPLOADS_ENABLED` says, because rows left over from a deployment that had it on still hold bytes.
 */
export function startUploadSweep(prisma: PrismaClient, intervalMs: number = UPLOAD_SWEEP_INTERVAL_MS): UploadSweeper {
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    sweepUploads(prisma)
      .then((result) => {
        if (result !== undefined && result.expired > 0) {
          console.info(`upload sweep: ${result.expired} uploads nothing fetched expired, ${result.parts} part rows deleted`);
        }
      })
      .catch((error: unknown) => {
        console.warn(`the upload sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
