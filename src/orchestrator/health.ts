import { createServer, type Server } from "node:http";

/**
 * Liveness: alive while a pass has succeeded within the last three intervals, counting from startup before the
 * first. A pass that cannot claim (the hub or the token is failing) does not count, so a stuck orchestrator is
 * restarted rather than quietly doing nothing.
 */

export const HEALTH_PATHS: readonly string[] = ["/health", "/health/liveness", "/health/readiness"];

export interface Health {
  passed(): void;
  alive(): boolean;
}

export function createHealth(intervalMs: number, now: () => number = Date.now): Health {
  let last = now();
  return {
    passed() {
      last = now();
    },
    alive() {
      return now() - last <= 3 * intervalMs;
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
    response.writeHead(alive ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify({ status: alive ? "UP" : "DOWN" }));
  });
}
