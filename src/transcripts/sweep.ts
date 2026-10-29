import type { PrismaClient } from "../store/prisma.ts";
import { MAX_ENTRIES_PER_AGENT, RETENTION_DAYS } from "./limits.ts";

/** Transcripts only need trimming at about the rate they grow, so this runs far less often than the offline sweep. */
export const TRANSCRIPT_SWEEP_INTERVAL_MS = 10 * 60_000;

/** Entries deleted per rule per sweep, so a backlog drains over a few ticks rather than in one long transaction. */
export const TRANSCRIPT_SWEEP_BATCH = 5_000;

/**
 * How recently an agent must have been heard from for the per-agent cap to be applied to it.
 *
 * Only an agent entries are still arriving for can newly pass the cap, and counting every agent the hub has ever
 * held to find out which ones have is a read of every entry it has ever stored, on every tick, to answer "none of
 * them" nearly every time. So the trim asks the cheap question first and only counts the entries of the agents that
 * pass it.
 *
 * `last_heartbeat_at` rather than an entry's `occurred_at`: the hub sets it, on registration and on every heartbeat,
 * where `occurred_at` is whatever the client read off its own transcript line. Gating on that would let a host with
 * a clock set back, or one backfilling an old session's file, upload entries that never look recent and so never
 * have the cap applied at all. It is also a safe over-estimate of what we want — a bridge uploads every 3 seconds
 * and heartbeats every 30, so an agent receiving entries always has a heartbeat at least as recent, while an agent
 * that is merely connected and quiet costs one count query and is found to be under the cap.
 *
 * A day, so that an agent stays eligible for about 144 ticks after its session ends — far more than the
 * `TRANSCRIPT_SWEEP_BATCH` steps any real overshoot needs to drain. The trade is at the far end: an agent that
 * passes the cap and is then never heard from again keeps whatever it was over by until `RETENTION_DAYS` ages those
 * entries out, retention being the backstop for exactly that.
 */
export const TRIM_ACTIVE_WITHIN_DAYS = 1;

/** "trnsswep". Distinct from the migration and offline-sweep locks. */
const TRANSCRIPT_SWEEP_LOCK_KEY = 0x74726e73_73776570n;

export interface TranscriptSweepOptions {
  retentionDays?: number;
  maxPerAgent?: number;
  batch?: number;
  activeWithinDays?: number;
}

export interface TranscriptSweepResult {
  /** Entries deleted for being older than the retention period. */
  expired: number;
  /** Entries deleted for being beyond an agent's newest `maxPerAgent`. */
  trimmed: number;
}

/**
 * Deletes a batch of the entries that occurred longer ago than `retentionDays`, then a batch of the oldest entries
 * beyond its newest `maxPerAgent` of each agent heard from within `activeWithinDays`. Nothing is announced: a page
 * already showing an entry keeps it until it re-reads.
 *
 * The same transaction-scoped `pg_try_advisory_xact_lock` as the offline sweep, so one pod sweeps per tick.
 * `undefined` means another pod held the lock.
 */
export async function sweepTranscripts(prisma: PrismaClient, options: TranscriptSweepOptions = {}): Promise<TranscriptSweepResult | undefined> {
  const {
    retentionDays = RETENTION_DAYS,
    maxPerAgent = MAX_ENTRIES_PER_AGENT,
    batch = TRANSCRIPT_SWEEP_BATCH,
    activeWithinDays = TRIM_ACTIVE_WITHIN_DAYS
  } = options;
  return await prisma.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${TRANSCRIPT_SWEEP_LOCK_KEY}) AS locked`;
    if (lock?.locked !== true) {
      return undefined;
    }
    // created_at, set here on insert, and not occurred_at, which the client sends and nothing bounds above: an entry
    // stamped in the future is never reached by a cut-off measured against occurred_at, and the trim below ranks it
    // as the agent's newest, so between them they kept it for good. This is the one rule that answers for every
    // entry whatever its contents claim, so it is the one that has to key on a column the hub owns.
    const expired = await tx.$executeRaw`
      DELETE FROM transcript_entry
       WHERE id IN (
         SELECT id FROM transcript_entry
          WHERE created_at < now() - make_interval(days => ${retentionDays}::int)
          LIMIT ${batch}::int
       )
    `;
    const trimmed = await tx.$executeRaw`
      DELETE FROM transcript_entry
       WHERE id IN (
         SELECT id FROM (
           SELECT id, row_number() OVER (PARTITION BY agent_id ORDER BY occurred_at DESC, id DESC) AS newest
             FROM transcript_entry
            -- The agents now over the cap, of those heard from lately. ANY (ARRAY(...)) rather than IN (...) at both
            -- steps: IN is planned as a semi-join, and with no useful row estimate for either set Postgres picks a
            -- merge join and reads the whole of an index to find the handful of rows it wants. Each array is built
            -- once, so every step above it stays an index-only scan of just the agents named in it.
            WHERE agent_id = ANY (ARRAY(
                    SELECT agent_id
                      FROM transcript_entry
                     WHERE agent_id = ANY (ARRAY(
                             SELECT a.id
                               FROM agent a
                              WHERE a.last_heartbeat_at >= now() - make_interval(days => ${activeWithinDays}::int)
                           ))
                     GROUP BY agent_id
                    HAVING count(*) > ${maxPerAgent}::int
                  ))
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
