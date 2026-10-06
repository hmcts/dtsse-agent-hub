import type { PrismaClient } from "../store/prisma.ts";
import { CLAIM_TIMEOUT_MS, dueEveningStop, isIdle, lastActivity, PROVISIONING_TIMEOUT_MS } from "./cleanup.ts";
import { eveningStop, idleMinutes, type WallClock } from "./settings.ts";
import { announce, stopVirtualAgents } from "./stop.ts";

export const VIRTUAL_AGENT_SWEEP_INTERVAL_MS = 60_000;

/** "virtagnt". Distinct from the migration, offline-sweep and transcript-sweep locks. */
const VIRTUAL_AGENT_SWEEP_LOCK_KEY = 0x76697274_61676e74n;

export interface VirtualAgentSweepOptions {
  now?: Date;
  idleMinutes?: number;
  eveningStop?: WallClock;
}

export interface VirtualAgentSweepResult {
  /** Agents failed for saying nothing since they were scheduled. */
  failed: string[];
  /** Agents whose pending logins expired. */
  loginsExpired: string[];
  /** Claims released because their orchestrator never reported. */
  claimsReleased: number;
  /** Agents stopped for being idle. */
  idle: string[];
  /** Agents stopped at the end of the working day. */
  evening: string[];
}

interface Candidate {
  id: string;
  status: string;
  started_at: Date;
  status_changed_at: Date;
  last_active_at: Date | null;
  agent_status: string | null;
  last_entry_at: Date | null;
}

/**
 * One pass over the virtual agents, under the same transaction-scoped advisory lock idiom as the other sweeps so
 * one pod sweeps per tick; `undefined` means another pod held the lock. Every time is the sweep's `now`, not the
 * database's, so a test can move the clock.
 *
 * - a pod still `provisioning` with nothing from it for `PROVISIONING_TIMEOUT_MS` is failed;
 * - logins past their expiry are expired, and pasted codes past theirs are removed;
 * - claims older than `CLAIM_TIMEOUT_MS` are released, so another orchestrator may take them;
 * - on a weekday evening every agent still meant to be running, unless started after the stop time, is stopped;
 * - otherwise a running agent whose linked agent is not busy and that has shown no activity, no transcript entry or
 *   pod report, for the idle period is stopped.
 */
export async function sweepVirtualAgents(prisma: PrismaClient, options: VirtualAgentSweepOptions = {}): Promise<VirtualAgentSweepResult | undefined> {
  const now = options.now ?? new Date();
  const idle = options.idleMinutes ?? idleMinutes();
  const stop = options.eveningStop ?? eveningStop();
  return await prisma.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${VIRTUAL_AGENT_SWEEP_LOCK_KEY}) AS locked`;
    if (lock?.locked !== true) {
      return undefined;
    }

    const silentSince = new Date(now.getTime() - PROVISIONING_TIMEOUT_MS);
    const failed = await tx.$queryRaw<{ id: string; owner_oid: string }[]>`
      UPDATE virtual_agent
         SET status = 'failed', status_detail = 'the pod said nothing for 15 minutes after it was scheduled', status_changed_at = ${now}, updated_at = ${now}
       WHERE desired = 'running' AND status = 'provisioning'
         AND GREATEST(status_changed_at, COALESCE(last_active_at, status_changed_at)) <= ${silentSince}
      RETURNING id::text AS id, owner_oid
    `;

    const expired = await tx.$queryRaw<{ id: string; owner_oid: string }[]>`
      WITH expired AS (
        UPDATE virtual_agent_login
           SET state = 'expired', pasted_code_ciphertext = NULL, pasted_code_iv = NULL, pasted_code_tag = NULL, pasted_code_expires_at = NULL,
               updated_at = ${now}
         WHERE state = 'pending' AND expires_at <= ${now}
        RETURNING virtual_agent_id
      )
      SELECT DISTINCT v.id::text AS id, v.owner_oid FROM expired e JOIN virtual_agent v ON v.id = e.virtual_agent_id
    `;
    await tx.$executeRaw`
      UPDATE virtual_agent_login
         SET pasted_code_ciphertext = NULL, pasted_code_iv = NULL, pasted_code_tag = NULL, pasted_code_expires_at = NULL, updated_at = ${now}
       WHERE pasted_code_expires_at <= ${now}
    `;

    const claimsReleased = await tx.$executeRaw`
      UPDATE virtual_agent SET claimed_by = NULL, claimed_at = NULL WHERE claimed_at <= ${new Date(now.getTime() - CLAIM_TIMEOUT_MS)}
    `;

    for (const row of [...failed, ...expired]) {
      await announce(tx, row.id, row.owner_oid);
    }

    const candidates = await tx.$queryRaw<Candidate[]>`
      SELECT v.id::text AS id, v.status::text AS status, v.started_at, v.status_changed_at, v.last_active_at, a.status::text AS agent_status,
             (SELECT max(t.created_at) FROM transcript_entry t WHERE t.agent_id = v.agent_id) AS last_entry_at
        FROM virtual_agent v
        LEFT JOIN agent a ON a.id = v.agent_id
       WHERE v.desired = 'running'
    `;
    const evening = candidates.filter((candidate) => dueEveningStop(candidate.started_at, now, stop)).map((candidate) => candidate.id);
    const idling = candidates
      .filter((candidate) => !evening.includes(candidate.id) && candidate.status === "running")
      .filter((candidate) => {
        // A start is activity: an agent started again after a night stopped has only yesterday's timestamps otherwise.
        const active =
          lastActivity(candidate.started_at, candidate.status_changed_at, candidate.last_active_at, candidate.last_entry_at) ?? candidate.started_at;
        return isIdle(candidate.agent_status, active, now, idle);
      })
      .map((candidate) => candidate.id);

    const stoppedEvening = await stopVirtualAgents(tx, evening, "evening", now);
    const stoppedIdle = await stopVirtualAgents(tx, idling, "idle", now);

    return {
      failed: failed.map((row) => row.id),
      loginsExpired: expired.map((row) => row.id),
      claimsReleased,
      idle: stoppedIdle.map((row) => row.id),
      evening: stoppedEvening.map((row) => row.id)
    };
  });
}

export interface VirtualAgentSweeper {
  stop: () => void;
}

/** Runs `sweepVirtualAgents` on an interval, with the timer unreferenced as the other sweeps' are. */
export function startVirtualAgentSweep(prisma: PrismaClient, intervalMs: number = VIRTUAL_AGENT_SWEEP_INTERVAL_MS): VirtualAgentSweeper {
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    sweepVirtualAgents(prisma)
      .then((result) => {
        if (result !== undefined && result.failed.length + result.idle.length + result.evening.length > 0) {
          console.info(
            `virtual-agent sweep: ${result.failed.length} failed to start, ${result.idle.length} stopped as idle, ${result.evening.length} stopped for the evening`
          );
        }
      })
      .catch((error: unknown) => {
        console.warn(`the virtual-agent sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
