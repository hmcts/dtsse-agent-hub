import { createServer, type Server } from "node:http";
import type { Lease } from "./hub.ts";

/**
 * Liveness: alive while a pass has succeeded within the last three intervals, counting from startup before the
 * first. A pass that cannot claim (the hub or the token is failing) does not count, so a stuck orchestrator is
 * restarted rather than quietly doing nothing. A pass on standby does count: an orchestrator whose cluster does not
 * hold the hub's lease is meant to be idle, and restarting it would change nothing.
 */

export const HEALTH_PATHS: readonly string[] = ["/health", "/health/liveness", "/health/readiness"];

export interface Health {
  /** A pass succeeded; `standby` is the lease another cluster holds, when it was on standby. */
  passed(standby?: Lease): void;
  alive(): boolean;
  /** The lease the last successful pass stood by for, or `null` when it was active. */
  standby(): Lease | null;
}

export function createHealth(intervalMs: number, now: () => number = Date.now): Health {
  let last = now();
  let lease: Lease | null = null;
  return {
    passed(standby) {
      last = now();
      lease = standby ?? null;
    },
    alive() {
      return now() - last <= 3 * intervalMs;
    },
    standby() {
      return lease;
    }
  };
}

export function healthServer(health: Health): Server {
  return createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0] ?? "";
    if (request.method !== "GET" || !HEALTH_PATHS.includes(path)) {
      response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
      return;
    }
    const alive = health.alive();
    const lease = health.standby();
    const body = alive && lease !== null ? { status: "UP", standby: true, lease_holder: lease.cluster } : { status: alive ? "UP" : "DOWN" };
    response.writeHead(alive ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
}
