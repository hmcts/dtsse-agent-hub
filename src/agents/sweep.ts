import { notify } from "../realtime/notify.ts";
import type { PrismaClient } from "../store/prisma.ts";

export const SWEEP_INTERVAL_MS = 30_000;
export const OFFLINE_AFTER_SECONDS = 90;

/** "agntswep". Distinct from the migration lock. */
const SWEEP_LOCK_KEY = 0x61676e74_73776570n;

/**
 * Marks every agent silent for longer than `offlineAfterSeconds` offline, and announces each.
 *
 * `pg_try_advisory_xact_lock` so only one pod sweeps per tick, without queueing the others behind it. The
 * transaction-scoped form because the lock must be released with the transaction on the pooled connection it was
 * taken on; a session lock would stay on whichever pool connection happened to run it.
 *
 * `undefined` means another pod held the lock.
 */
export async function sweepOffline(prisma: PrismaClient, offlineAfterSeconds: number = OFFLINE_AFTER_SECONDS): Promise<string[] | undefined> {
  return await prisma.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${SWEEP_LOCK_KEY}) AS locked`;
    if (lock?.locked !== true) {
      return undefined;
    }
    const swept = await tx.$queryRaw<{ id: string; owner_oid: string }[]>`
      UPDATE agent SET status = 'offline'
       WHERE status <> 'offline' AND last_heartbeat_at < now() - make_interval(secs => ${offlineAfterSeconds}::double precision)
      RETURNING id::text AS id, owner_oid
    `;
    for (const agent of swept) {
      await notify(tx, { type: "agent_status", agent_id: agent.id, owner_oid: agent.owner_oid, status: "offline" });
    }
    return swept.map((agent) => agent.id);
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
      .then((swept) => {
        if (swept !== undefined && swept.length > 0) {
          console.info(`marked ${swept.length} silent agent${swept.length === 1 ? "" : "s"} offline`);
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
