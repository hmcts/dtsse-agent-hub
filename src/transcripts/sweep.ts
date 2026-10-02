import type { PrismaClient } from "../store/prisma.ts";
import { MAX_ENTRIES_PER_AGENT, RETENTION_DAYS } from "./limits.ts";

/** Transcripts only need trimming at about the rate they grow, so this runs far less often than the offline sweep. */
export const TRANSCRIPT_SWEEP_INTERVAL_MS = 10 * 60_000;

/** Entries deleted per rule per sweep, so a backlog drains over a few ticks rather than in one long transaction. */
export const TRANSCRIPT_SWEEP_BATCH = 5_000;

/** "trnsswep". Distinct from the migration and offline-sweep locks. */
const TRANSCRIPT_SWEEP_LOCK_KEY = 0x74726e73_73776570n;

export interface TranscriptSweepOptions {
  retentionDays?: number;
  maxPerAgent?: number;
  batch?: number;
}

export interface TranscriptSweepResult {
  /** Entries deleted for being older than the retention period. */
  expired: number;
  /** Entries deleted for being beyond an agent's newest `maxPerAgent`. */
  trimmed: number;
}

/**
 * Deletes a batch of the entries that occurred longer ago than `retentionDays`, then a batch of each agent's oldest
 * entries beyond its newest `maxPerAgent`. Nothing is announced: a page already showing an entry keeps it until it
 * re-reads.
 *
 * The same transaction-scoped `pg_try_advisory_xact_lock` as the offline sweep, so one pod sweeps per tick.
 * `undefined` means another pod held the lock.
 */
export async function sweepTranscripts(prisma: PrismaClient, options: TranscriptSweepOptions = {}): Promise<TranscriptSweepResult | undefined> {
  const { retentionDays = RETENTION_DAYS, maxPerAgent = MAX_ENTRIES_PER_AGENT, batch = TRANSCRIPT_SWEEP_BATCH } = options;
  return await prisma.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${TRANSCRIPT_SWEEP_LOCK_KEY}) AS locked`;
    if (lock?.locked !== true) {
      return undefined;
    }
    const expired = await tx.$executeRaw`
      DELETE FROM transcript_entry
       WHERE id IN (
         SELECT id FROM transcript_entry
          WHERE occurred_at < now() - make_interval(days => ${retentionDays}::int)
          LIMIT ${batch}::int
       )
    `;
    const trimmed = await tx.$executeRaw`
      DELETE FROM transcript_entry
       WHERE id IN (
         SELECT id FROM (
           SELECT id, row_number() OVER (PARTITION BY agent_id ORDER BY occurred_at DESC, id DESC) AS newest
             FROM transcript_entry
            WHERE agent_id IN (SELECT agent_id FROM transcript_entry GROUP BY agent_id HAVING count(*) > ${maxPerAgent}::int)
         ) ranked
          WHERE newest > ${maxPerAgent}::int
          LIMIT ${batch}::int
       )
    `;
    return { expired, trimmed };
  });
}

export interface TranscriptSweeper {
  stop: () => void;
}

/** Runs `sweepTranscripts` on an interval, with the timer unreferenced as the offline sweep's is. */
export function startTranscriptSweep(prisma: PrismaClient, intervalMs: number = TRANSCRIPT_SWEEP_INTERVAL_MS): TranscriptSweeper {
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    sweepTranscripts(prisma)
      .then((result) => {
        if (result !== undefined && (result.expired > 0 || result.trimmed > 0)) {
          console.info(`transcript sweep: ${result.expired} entries past retention and ${result.trimmed} over the per-agent cap deleted`);
        }
      })
      .catch((error: unknown) => {
        console.warn(`the transcript sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
