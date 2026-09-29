import pg from "pg";
import { decodeEvent, HUB_CHANNEL } from "./events.ts";
import type { EventHub } from "./hub.ts";

/**
 * One dedicated connection per pod doing `LISTEN hub_events`, republishing every notification into the pod's hub.
 *
 * Not a Prisma pool connection: `LISTEN` belongs to the session, and a pooled connection is handed to other queries
 * and may be recycled at any time.
 */

export interface ListenerOptions {
  connectionString: string;
  hub: EventHub;
  channel?: string;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  healthIntervalMs?: number;
  healthTimeoutMs?: number;
}

export interface Listener {
  /** Resolves once `LISTEN` is active for the first time. */
  ready: () => Promise<void>;
  connected: () => boolean;
  stop: () => Promise<void>;
}

const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

/**
 * A connection that only listens sends nothing, so a socket dropped without a FIN or RST (a NAT or load balancer
 * timing it out) looks healthy indefinitely. TCP keepalive probes it at the OS level, and the health query catches
 * what keepalive misses, such as a server that still acknowledges packets but no longer answers.
 */
export const KEEPALIVE_INITIAL_DELAY_MS = 30_000;
export const HEALTH_INTERVAL_MS = 30_000;
export const HEALTH_TIMEOUT_MS = 10_000;

/** Exponential with full jitter, so every pod does not reconnect at the same instant after a failover. */
export function backoffDelay(attempt: number, minMs: number = MIN_BACKOFF_MS, maxMs: number = MAX_BACKOFF_MS, random: () => number = Math.random): number {
  const ceiling = Math.min(maxMs, minMs * 2 ** attempt);
  return Math.max(minMs, Math.floor(random() * ceiling));
}

export function startListener({
  connectionString,
  hub,
  channel = HUB_CHANNEL,
  minBackoffMs,
  maxBackoffMs,
  healthIntervalMs = HEALTH_INTERVAL_MS,
  healthTimeoutMs = HEALTH_TIMEOUT_MS
}: ListenerOptions): Listener {
  let stopped = false;
  let client: pg.Client | undefined;
  let attempt = 0;
  let everConnected = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let health: ReturnType<typeof setInterval> | undefined;
  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  function scheduleReconnect(): void {
    if (stopped || retry !== undefined) {
      return;
    }
    const delay = backoffDelay(attempt, minBackoffMs, maxBackoffMs);
    attempt += 1;
    retry = setTimeout(() => {
      retry = undefined;
      void connect();
    }, delay);
    retry.unref();
  }

  function stopHealthChecks(): void {
    if (health !== undefined) {
      clearInterval(health);
      health = undefined;
    }
  }

  async function checkHealth(current: pg.Client): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        current.query("SELECT 1"),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(`no answer within ${healthTimeoutMs}ms`)), healthTimeoutMs);
        })
      ]);
    } catch (error) {
      drop(current, `health check failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  function startHealthChecks(current: pg.Client): void {
    stopHealthChecks();
    health = setInterval(() => void checkHealth(current), healthIntervalMs);
    health.unref();
  }

  function drop(current: pg.Client, reason: string): void {
    if (client !== current) {
      return;
    }
    client = undefined;
    stopHealthChecks();
    current.removeAllListeners();
    // A client that errored may still emit; an unhandled `error` event would crash the process.
    current.on("error", () => undefined);
    current.end().catch(() => undefined);
    if (!stopped) {
      console.warn(`the ${channel} listener lost its connection (${reason}); reconnecting`);
      scheduleReconnect();
    }
  }

  async function connect(): Promise<void> {
    if (stopped) {
      return;
    }
    const current = new pg.Client({
      connectionString,
      keepAlive: true,
      keepAliveInitialDelayMillis: KEEPALIVE_INITIAL_DELAY_MS,
      application_name: "dtsse-agent-hub-listener"
    });
    client = current;
    current.on("error", (error) => drop(current, error.message));
    current.on("end", () => drop(current, "connection ended"));
    current.on("notification", (message) => {
      if (message.channel !== channel) {
        return;
      }
      const event = decodeEvent(message.payload);
      if (event === undefined) {
        console.warn(`ignored an unreadable ${channel} notification`);
        return;
      }
      hub.publish(event);
    });

    try {
      await current.connect();
      await current.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
    } catch (error) {
      drop(current, error instanceof Error ? error.message : String(error));
      return;
    }
    if (stopped || client !== current) {
      await current.end().catch(() => undefined);
      return;
    }

    attempt = 0;
    startHealthChecks(current);
    if (everConnected) {
      hub.publish({ type: "resync" });
    }
    everConnected = true;
    resolveReady();
  }

  void connect();

  return {
    ready: () => ready,
    connected: () => client !== undefined && everConnected,
    stop: async () => {
      stopped = true;
      if (retry !== undefined) {
        clearTimeout(retry);
        retry = undefined;
      }
      stopHealthChecks();
      const current = client;
      client = undefined;
      if (current !== undefined) {
        current.removeAllListeners();
        current.on("error", () => undefined);
        await current.end().catch(() => undefined);
      }
    }
  };
}
