import type pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heartbeat } from "../../src/agents/store.ts";
import { startOfflineSweep, sweepOffline } from "../../src/agents/sweep.ts";
import { ackDelivery, createDirect, queuedDeliveries } from "../../src/messages/store.ts";
import { decodeEvent, HUB_CHANNEL, type NotifiedEvent } from "../../src/realtime/events.ts";
import type { PrismaClient } from "../../src/store/prisma.ts";
import { connect, insertAgent, person, prisma, resetDatabase } from "./database.ts";

const ALICE = person("alice");
const BOB = person("bob");
const DAY_SECONDS = 24 * 60 * 60;

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

function secondsAgo(seconds: number): Date {
  return new Date(Date.now() - seconds * 1000);
}

describe("sweepOffline", () => {
  it("should mark only agents silent for longer than 90 seconds offline", async () => {
    const stale = await insertAgent(ALICE, "stale", { status: "busy", lastHeartbeatAt: secondsAgo(120) });
    const fresh = await insertAgent(ALICE, "fresh", { status: "idle", lastHeartbeatAt: secondsAgo(30) });
    const gone = await insertAgent(ALICE, "gone", { status: "offline", lastHeartbeatAt: secondsAgo(3600) });

    expect(await sweepOffline(prisma)).toEqual({ offline: [stale], expired: 0 });

    const statuses = Object.fromEntries((await prisma.agent.findMany()).map((agent) => [agent.id, agent.status]));
    expect(statuses).toEqual({ [stale]: "offline", [fresh]: "idle", [gone]: "offline" });
  });

  it("should stand down while another pod holds the sweep lock", async () => {
    const stale = await insertAgent(ALICE, "stale", { lastHeartbeatAt: secondsAgo(120) });
    const other = await connect();
    try {
      await other.query("BEGIN");
      await other.query("SELECT pg_advisory_xact_lock($1)", [0x61676e74_73776570n.toString()]);

      expect(await sweepOffline(prisma)).toBeUndefined();
      expect((await prisma.agent.findUniqueOrThrow({ where: { id: stale } })).status).toBe("idle");

      await other.query("COMMIT");
      expect(await sweepOffline(prisma)).toEqual({ offline: [stale], expired: 0 });
    } finally {
      await other.end();
    }
  });
});

describe("delivery expiry", () => {
  let sender: string;
  let listener: pg.Client;
  let heard: NotifiedEvent[];

  async function directTo(agentId: string): Promise<string> {
    return (await createDirect(prisma, { author: { oid: ALICE.oid, agentId: sender }, targetAgentId: agentId, inReplyTo: null, body: "hello" })).id;
  }

  async function stateOf(messageId: string, agentId: string): Promise<string> {
    return (await prisma.delivery.findUniqueOrThrow({ where: { messageId_agentId: { messageId: BigInt(messageId), agentId } } })).state;
  }

  async function deliveryEvents(): Promise<NotifiedEvent[]> {
    await listener.query("SELECT 1");
    return heard.filter((event) => event.type === "delivery");
  }

  beforeEach(async () => {
    sender = await insertAgent(ALICE, "sender");
    heard = [];
    listener = await connect();
    listener.on("notification", (notification) => {
      const event = decodeEvent(notification.payload);
      if (event !== undefined) {
        heard.push(event);
      }
    });
    await listener.query(`LISTEN ${HUB_CHANNEL}`);
  });

  afterEach(async () => {
    await listener.end();
  });

  it("should expire a queued delivery and announce it when the target has been offline for over a day", async () => {
    const gone = await insertAgent(BOB, "gone", { status: "offline", lastHeartbeatAt: secondsAgo(DAY_SECONDS + 60) });
    const messageId = await directTo(gone);

    expect(await sweepOffline(prisma)).toEqual({ offline: [], expired: 1 });

    expect(await stateOf(messageId, gone)).toBe("expired");
    expect(await deliveryEvents()).toEqual([{ type: "delivery", message_id: messageId, agent_id: gone, state: "expired" }]);
  });

  it("should leave a delivery queued when the target went offline less than a day ago", async () => {
    const recent = await insertAgent(BOB, "recent", { status: "offline", lastHeartbeatAt: secondsAgo(3600) });
    const messageId = await directTo(recent);

    expect(await sweepOffline(prisma)).toEqual({ offline: [], expired: 0 });

    expect(await stateOf(messageId, recent)).toBe("queued");
    expect(await deliveryEvents()).toEqual([]);
  });

  it("should leave a delivery queued when the target is online", async () => {
    const online = await insertAgent(BOB, "online", { status: "idle", lastHeartbeatAt: secondsAgo(10) });
    const messageId = await directTo(online);

    expect(await sweepOffline(prisma, { expireAfterSeconds: 0 })).toEqual({ offline: [], expired: 0 });

    expect(await stateOf(messageId, online)).toBe("queued");
  });

  it("should leave an acked delivery delivered when its target has been offline for over a day", async () => {
    const gone = await insertAgent(BOB, "gone", { status: "offline", lastHeartbeatAt: secondsAgo(DAY_SECONDS + 60) });
    const messageId = await directTo(gone);
    await ackDelivery(prisma, gone, BigInt(messageId));

    expect(await sweepOffline(prisma)).toEqual({ offline: [], expired: 0 });

    expect(await stateOf(messageId, gone)).toBe("delivered");
  });

  it("should expire the oldest deliveries first, a batch at a time, when there are more than a batch", async () => {
    const gone = await insertAgent(BOB, "gone", { status: "offline", lastHeartbeatAt: secondsAgo(DAY_SECONDS + 60) });
    const first = await directTo(gone);
    const second = await directTo(gone);
    const third = await directTo(gone);

    expect(await sweepOffline(prisma, { expireBatch: 2 })).toEqual({ offline: [], expired: 2 });
    expect([await stateOf(first, gone), await stateOf(second, gone), await stateOf(third, gone)]).toEqual(["expired", "expired", "queued"]);

    expect(await sweepOffline(prisma, { expireBatch: 2 })).toEqual({ offline: [], expired: 1 });
    expect(await stateOf(third, gone)).toBe("expired");
  });

  it("should not replay or re-deliver an expired delivery when the agent comes back", async () => {
    const gone = await insertAgent(BOB, "gone", { status: "offline", lastHeartbeatAt: secondsAgo(DAY_SECONDS + 60) });
    const messageId = await directTo(gone);
    await sweepOffline(prisma);

    await heartbeat(prisma, gone, "idle", null);

    expect(await queuedDeliveries(prisma, gone)).toEqual([]);
    expect(await ackDelivery(prisma, gone, BigInt(messageId))).toBe(true);
    expect(await stateOf(messageId, gone)).toBe("expired");
  });
});

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the sweeper");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("startOfflineSweep", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should log what a tick changed, and nothing for a tick that changed nothing or stood down", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const stale = await insertAgent(ALICE, "stale", { lastHeartbeatAt: secondsAgo(120) });
    const gone = await insertAgent(BOB, "gone", { status: "offline", lastHeartbeatAt: secondsAgo(DAY_SECONDS + 60) });
    await createDirect(prisma, { author: { oid: ALICE.oid, agentId: stale }, targetAgentId: gone, inReplyTo: null, body: "hello" });
    const transaction = vi.spyOn(prisma, "$transaction");
    const other = await connect();
    const sweeper = startOfflineSweep(prisma, 10);
    try {
      await other.query("BEGIN");
      await other.query("SELECT pg_advisory_xact_lock($1)", [0x61676e74_73776570n.toString()]);
      await until(() => transaction.mock.calls.length >= 2);
      expect(info).not.toHaveBeenCalled();

      await other.query("COMMIT");
      await until(() => info.mock.calls.length > 0);
      const calls = transaction.mock.calls.length;
      await until(() => transaction.mock.calls.length >= calls + 2);

      expect(info.mock.calls).toEqual([["offline sweep: 1 silent agents marked offline, 1 queued deliveries expired"]]);
    } finally {
      sweeper.stop();
      await other.end();
    }
  });

  it("should warn when a tick fails, and skip ticks while one is still running", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failures: unknown[] = [new Error("database gone"), "not an error"];
    let started = 0;
    const failing = {
      $transaction: () => {
        const failure = failures[started++ % failures.length];
        return new Promise((_, reject) => setTimeout(() => reject(failure), 50));
      }
    } as unknown as PrismaClient;
    const sweeper = startOfflineSweep(failing, 5);
    try {
      await until(() => warn.mock.calls.length >= 2);
    } finally {
      sweeper.stop();
    }

    expect(warn.mock.calls.slice(0, 2)).toEqual([["the offline sweep failed: database gone"], ["the offline sweep failed: not an error"]]);
    expect(started).toBeLessThanOrEqual(warn.mock.calls.length + 1);
  });
});
