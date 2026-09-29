import type { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubEvent } from "./events.ts";
import { HEALTH_INTERVAL_MS, HEALTH_TIMEOUT_MS } from "./health.ts";
import { createEventHub } from "./hub.ts";
import { backoffDelay, KEEPALIVE_INITIAL_DELAY_MS, startListener } from "./listener.ts";

interface FakeClient extends EventEmitter {
  config: Record<string, unknown>;
  queries: string[];
  answer: (sql: string) => Promise<unknown>;
  ended: boolean;
}

const clients = vi.hoisted(() => [] as FakeClient[]);

vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  function Client(config: Record<string, unknown>): FakeClient {
    const client = Object.assign(new EventEmitter(), {
      config,
      queries: [] as string[],
      answer: async (_sql: string): Promise<unknown> => ({ rows: [] }),
      ended: false,
      connect: async () => undefined,
      query(sql: string) {
        client.queries.push(sql);
        return client.answer(sql);
      },
      end: async () => {
        client.ended = true;
      }
    });
    clients.push(client);
    return client;
  }
  return { default: { Client, escapeIdentifier: (name: string) => `"${name}"` } };
});

function listen() {
  const hub = createEventHub();
  const events: HubEvent[] = [];
  hub.subscribe((event) => events.push(event));
  const listener = startListener({ connectionString: "postgresql://test", hub, minBackoffMs: 100, maxBackoffMs: 100 });
  return { listener, events };
}

describe("startListener", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clients.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("should probe the socket with TCP keepalive after a short idle rather than the OS default", async () => {
    const { listener } = listen();
    await listener.ready();

    expect(clients[0]?.config).toMatchObject({ keepAlive: true, keepAliveInitialDelayMillis: KEEPALIVE_INITIAL_DELAY_MS });
    await listener.stop();
  });

  it("should run a health query every interval and keep the connection while it answers", async () => {
    const { listener, events } = listen();
    await listener.ready();

    await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 2);

    expect(clients).toHaveLength(1);
    expect(clients[0]?.queries).toEqual(['LISTEN "hub_events"', "SELECT 1", "SELECT 1"]);
    expect(listener.connected()).toBe(true);
    expect(events).toEqual([]);
    await listener.stop();
  });

  it("should reconnect and publish a resync when the health query fails", async () => {
    const { listener, events } = listen();
    await listener.ready();
    clients[0]!.answer = () => Promise.reject(new Error("terminating connection"));

    await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
    expect(clients[0]?.ended).toBe(true);
    expect(listener.connected()).toBe(false);
    await vi.advanceTimersByTimeAsync(100);

    expect(clients).toHaveLength(2);
    expect(clients[1]?.queries).toEqual(['LISTEN "hub_events"']);
    expect(listener.connected()).toBe(true);
    expect(events).toEqual([{ type: "resync" }]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("health check failed: terminating connection"));
    await listener.stop();
  });

  it("should reconnect and publish a resync when the health query does not answer in time", async () => {
    const { listener, events } = listen();
    await listener.ready();
    clients[0]!.answer = () => new Promise(() => undefined);

    await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS + HEALTH_TIMEOUT_MS - 1);
    expect(listener.connected()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(100);

    expect(clients).toHaveLength(2);
    expect(events).toEqual([{ type: "resync" }]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`no answer within ${HEALTH_TIMEOUT_MS}ms`));
    await listener.stop();
  });

  it("should stop the health queries when it stops", async () => {
    const { listener } = listen();
    await listener.ready();

    await listener.stop();
    await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 3);

    expect(clients[0]?.queries).toEqual(['LISTEN "hub_events"']);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("backoffDelay", () => {
  it("should never wait less than the minimum, even when the jitter draws zero", () => {
    expect(backoffDelay(0, 500, 30_000, () => 0)).toBe(500);
  });

  it("should double the ceiling with each failed attempt", () => {
    expect(backoffDelay(1, 500, 30_000, () => 0.5)).toBe(500);
    expect(backoffDelay(3, 500, 30_000, () => 0.5)).toBe(2000);
  });

  it("should cap the wait at the maximum however many attempts have failed", () => {
    expect(backoffDelay(50, 500, 30_000, () => 0.999_999)).toBeLessThanOrEqual(30_000);
    expect(backoffDelay(50, 500, 30_000, () => 0.999_999)).toBeGreaterThan(29_000);
  });
});
