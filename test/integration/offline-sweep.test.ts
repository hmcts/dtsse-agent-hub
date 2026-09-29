import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sweepOffline } from "../../src/agents/sweep.ts";
import { connect, insertAgent, person, prisma, resetDatabase } from "./database.ts";

const ALICE = person("alice");

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

    expect(await sweepOffline(prisma)).toEqual([stale]);

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
      expect(await sweepOffline(prisma)).toEqual([stale]);
    } finally {
      await other.end();
    }
  });
});
