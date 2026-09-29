import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { heartbeat, markOffline } from "../../src/agents/store.ts";
import { createDirect, createPost } from "../../src/messages/store.ts";
import type { HubEvent } from "../../src/realtime/events.ts";
import { createEventHub, type EventHub } from "../../src/realtime/hub.ts";
import { type Listener, startListener } from "../../src/realtime/listener.ts";
import { resolveDatabaseUrl } from "../../src/store/database-url.ts";
import { connect, insertAgent, person, prisma, resetDatabase } from "./database.ts";

const ALICE = person("alice");
const BOB = person("bob");

interface Pod {
  hub: EventHub;
  listener: Listener;
  events: HubEvent[];
}

async function pod(): Promise<Pod> {
  const hub = createEventHub();
  const events: HubEvent[] = [];
  hub.subscribe((event) => events.push(event));
  const listener = startListener({ connectionString: resolveDatabaseUrl(), hub, minBackoffMs: 20, maxBackoffMs: 100 });
  await listener.ready();
  return { hub, listener, events };
}

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for an event");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

let pods: Pod[] = [];

beforeEach(async () => {
  await resetDatabase();
  pods = [await pod(), await pod()];
});

afterEach(async () => {
  await Promise.all(pods.map((running) => running.listener.stop()));
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("NOTIFY fan-out between pods", () => {
  it("should deliver a direct message, a post and status changes to every pod's hub", async () => {
    const alicesAgent = await insertAgent(ALICE, "alice");
    const bobsAgent = await insertAgent(BOB, "bob");

    const direct = await createDirect(prisma, { author: { oid: ALICE.oid, agentId: alicesAgent }, targetAgentId: bobsAgent, inReplyTo: null, body: "hi" });
    const post = await createPost(prisma, { author: { oid: BOB.oid, agentId: bobsAgent }, topics: ["ccd"], title: null, body: "news", inReplyTo: null });
    await heartbeat(prisma, bobsAgent, "busy", null);
    await markOffline(prisma, alicesAgent);

    const expected: HubEvent[] = [
      { type: "direct", message_id: direct.id, target_agent_id: bobsAgent, author_agent_id: alicesAgent },
      { type: "post", message_id: post.id },
      { type: "agent_status", agent_id: bobsAgent, owner_oid: BOB.oid, status: "busy" },
      { type: "agent_status", agent_id: alicesAgent, owner_oid: ALICE.oid, status: "offline" }
    ];
    for (const running of pods) {
      await until(() => running.events.length >= expected.length);
      expect(running.events).toEqual(expected);
    }
  });

  it("should announce a heartbeat only when the status changed", async () => {
    const agent = await insertAgent(ALICE, "alice");

    await heartbeat(prisma, agent, "idle", null);
    await heartbeat(prisma, agent, "busy", null);
    await heartbeat(prisma, agent, "busy", null);

    await until(() => pods[0]!.events.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(pods[0]!.events).toEqual([{ type: "agent_status", agent_id: agent, owner_oid: ALICE.oid, status: "busy" }]);
  });

  it("should not notify for a write that rolled back", async () => {
    const agent = await insertAgent(ALICE, "alice");

    await expect(
      createPost(prisma, {
        author: { oid: ALICE.oid, agentId: agent },
        topics: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"],
        title: null,
        body: "too many",
        inReplyTo: null
      })
    ).rejects.toThrow();
    await heartbeat(prisma, agent, "busy", null);

    await until(() => pods[0]!.events.length >= 1);
    expect(pods[0]!.events).toEqual([{ type: "agent_status", agent_id: agent, owner_oid: ALICE.oid, status: "busy" }]);
  });

  it("should reconnect after its connection is killed and ask every stream to resync", async () => {
    const admin = await connect();
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'dtsse-agent-hub-listener' AND pid <> pg_backend_pid()`
      );

      for (const running of pods) {
        await until(() => running.events.some((event) => event.type === "resync"));
      }
      await until(() => pods.every((running) => running.listener.connected()));

      const agent = await insertAgent(ALICE, "alice");
      await heartbeat(prisma, agent, "busy", null);
      for (const running of pods) {
        await until(() => running.events.some((event) => event.type === "agent_status"));
      }
    } finally {
      await admin.end();
    }
  });
});
