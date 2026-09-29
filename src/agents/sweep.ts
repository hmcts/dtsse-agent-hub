import { expireDeliveries } from "../messages/store.ts";
import { notify } from "../realtime/notify.ts";
import type { PrismaClient } from "../store/prisma.ts";
import { EXPIRE_AFTER_SECONDS, OFFLINE_AFTER_SECONDS } from "./liveness.ts";

export const SWEEP_INTERVAL_MS = 30_000;

/** Deliveries expired per sweep, so a backlog drains over a few ticks rather than in one long transaction. */
export const EXPIRE_BATCH = 200;

/** "agntswep". Distinct from the migration lock. */
const SWEEP_LOCK_KEY = 0x61676e74_73776570n;

export interface SweepOptions {
  expireAfterSeconds?: number;
  expireBatch?: number;
}

export interface SweepResult {
  /** The agents marked offline. */
  offline: string[];
  /** How many deliveries were expired. */
  expired: number;
}

/**
 * Marks every agent silent for longer than `OFFLINE_AFTER_SECONDS` offline, and announces each; then expires a batch
 * of the deliveries queued for agents offline longer than `expireAfterSeconds`.
 *
 * `pg_try_advisory_xact_lock` so only one pod sweeps per tick, without queueing the others behind it. The
 * transaction-scoped form because the lock must be released with the transaction on the pooled connection it was
 * taken on; a session lock would stay on whichever pool connection happened to run it.
 *
 * `undefined` means another pod held the lock.
 */
export async function sweepOffline(prisma: PrismaClient, options: SweepOptions = {}): Promise<SweepResult | undefined> {
  const { expireAfterSeconds = EXPIRE_AFTER_SECONDS, expireBatch = EXPIRE_BATCH } = options;
  return await prisma.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${SWEEP_LOCK_KEY}) AS locked`;
    if (lock?.locked !== true) {
      return undefined;
    }
    const swept = await tx.$queryRaw<{ id: string; owner_oid: string }[]>`
      UPDATE agent SET status = 'offline'
       WHERE status <> 'offline' AND last_heartbeat_at < now() - make_interval(secs => ${OFFLINE_AFTER_SECONDS}::double precision)
      RETURNING id::text AS id, owner_oid
    `;
    for (const agent of swept) {
      await notify(tx, { type: "agent_status", agent_id: agent.id, owner_oid: agent.owner_oid, status: "offline" });
    }
    const expired = await expireDeliveries(tx, expireAfterSeconds, expireBatch);
    return { offline: swept.map((agent) => agent.id), expired };
  });
}

export interface Sweeper {
  stop: () => void;
}

/** Runs `sweepOffline` on an interval. The timer is unreferenced: the server's socket keeps the process alive, not this. */
export function startOfflineSweep(prisma: PrismaClient, intervalMs: number = SWEEP_INTERVAL_MS): Sweeper {
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    sweepOffline(prisma)
      .then((result) => {
        if (result !== undefined && (result.offline.length > 0 || result.expired > 0)) {
          console.info(`offline sweep: ${result.offline.length} silent agents marked offline, ${result.expired} queued deliveries expired`);
        }
      })
      .catch((error: unknown) => {
        console.warn(`the offline sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
