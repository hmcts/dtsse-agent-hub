import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { heartbeat, markOffline, registerAgent } from "../../src/agents/store.ts";
import { sweepOffline } from "../../src/agents/sweep.ts";
import { linkLocalSession } from "../../src/assistant/local-chat-store.ts";
import { createDirect, createPost } from "../../src/messages/store.ts";
import type { HubEvent } from "../../src/realtime/events.ts";
import { createEventHub, type EventHub } from "../../src/realtime/hub.ts";
import { type Listener, startListener } from "../../src/realtime/listener.ts";
import { resolveDatabaseUrl } from "../../src/store/database-url.ts";
import { connect, insertAgent, person, prisma, resetDatabase } from "./database.ts";
import { WAIT_MS } from "./waits.ts";

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

async function until(check: () => boolean, timeoutMs = WAIT_MS): Promise<void> {
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

/**
 * `insertAgent` writes the row directly, so its agent has no conversation — and a heartbeat gives a laptop session
 * one. These are tests about fan-out rather than about conversations, so each agent whose heartbeat they exercise is
 * given one first, which is the state every registered session is in anyway. The link announces nothing, since the
 * chat it makes has nothing in it yet.
 */
async function settled(agentId: string, ownerOid: string, name: string): Promise<string> {
  await linkLocalSession(prisma, { ownerOid, agentId, name });
  return agentId;
}

async function chatOf(agentId: string): Promise<string | null> {
  const row = await prisma.agent.findUniqueOrThrow({ where: { id: agentId }, select: { assistantConversationId: true } });
  return row.assistantConversationId;
}

describe("NOTIFY fan-out between pods", () => {
  it("should deliver a direct message, a post and status changes to every pod's hub", async () => {
    const alicesAgent = await insertAgent(ALICE, "alice");
    const bobsAgent = await settled(await insertAgent(BOB, "bob"), BOB.oid, "bob");

    const direct = await createDirect(prisma, { author: { oid: ALICE.oid, agentId: alicesAgent }, targetAgentId: bobsAgent, inReplyTo: null, body: "hi" });
    const post = await createPost(prisma, { author: { oid: BOB.oid, agentId: bobsAgent }, topics: ["ccd"], title: null, body: "news", inReplyTo: null });
    await heartbeat(prisma, bobsAgent, "busy", null);
    await markOffline(prisma, alicesAgent);

    const expected: HubEvent[] = [
      { type: "direct", message_id: direct.id, target_agent_id: bobsAgent, author_agent_id: alicesAgent },
      // The direct is the first thing said in Bob's session's chat, which puts it in his sidebar.
      { type: "assistant_conversation", conversation_id: expect.any(String), virtual_agent_id: null, owner_oid: BOB.oid },
      { type: "post", message_id: post.id },
      { type: "agent_status", agent_id: bobsAgent, owner_oid: BOB.oid, status: "busy", local_conversation_id: await chatOf(bobsAgent) },
      { type: "agent_status", agent_id: alicesAgent, owner_oid: ALICE.oid, status: "offline", local_conversation_id: null }
    ];
    for (const running of pods) {
      await until(() => running.events.length >= expected.length);
      expect(running.events).toEqual(expected);
    }
  });

  it("should announce a heartbeat only when the status changed", async () => {
    const agent = await settled(await insertAgent(ALICE, "alice"), ALICE.oid, "alice");

    await heartbeat(prisma, agent, "idle", null);
    await heartbeat(prisma, agent, "busy", null);
    await heartbeat(prisma, agent, "busy", null);

    await until(() => pods[0]!.events.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(pods[0]!.events).toEqual([
      { type: "agent_status", agent_id: agent, owner_oid: ALICE.oid, status: "busy", local_conversation_id: await chatOf(agent) }
    ]);
  });

  it("should name a laptop session's chat on every status it announces, and no chat for a pod's agent", async () => {
    const laptop = await settled(await insertAgent(ALICE, "laptop"), ALICE.oid, "laptop");
    const stale = await settled(await insertAgent(ALICE, "stale", { status: "busy", lastHeartbeatAt: new Date(Date.now() - 600_000) }), ALICE.oid, "stale");
    const pod = await insertAgent(ALICE, "pod");
    const assistant = await prisma.virtualAgent.create({ data: { ownerOid: ALICE.oid, name: "assistant", modelRoute: "gateway" }, select: { id: true } });
    const chat = await prisma.assistantConversation.create({ data: { ownerOid: ALICE.oid, virtualAgentId: assistant.id, agentId: pod }, select: { id: true } });
    await prisma.agent.update({ where: { id: pod }, data: { assistantConversationId: chat.id, virtualAgentId: assistant.id } });

    await heartbeat(prisma, laptop, "busy", null);
    await heartbeat(prisma, pod, "busy", null);
    await markOffline(prisma, laptop);
    await sweepOffline(prisma);

    const expected: HubEvent[] = [
      { type: "agent_status", agent_id: laptop, owner_oid: ALICE.oid, status: "busy", local_conversation_id: await chatOf(laptop) },
      { type: "agent_status", agent_id: pod, owner_oid: ALICE.oid, status: "busy", local_conversation_id: null },
      { type: "agent_status", agent_id: laptop, owner_oid: ALICE.oid, status: "offline", local_conversation_id: await chatOf(laptop) },
      { type: "agent_status", agent_id: stale, owner_oid: ALICE.oid, status: "offline", local_conversation_id: await chatOf(stale) }
    ];
    await until(() => pods[0]!.events.length >= expected.length);
    expect(pods[0]!.events).toEqual(expected);
  });

  it("should not notify for a write that rolled back", async () => {
    const agent = await settled(await insertAgent(ALICE, "alice"), ALICE.oid, "alice");

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
    expect(pods[0]!.events).toEqual([
      { type: "agent_status", agent_id: agent, owner_oid: ALICE.oid, status: "busy", local_conversation_id: await chatOf(agent) }
    ]);
  });

  it("should reconnect after its connection is killed and ask every stream to resync", async () => {
    const admin = await connect();
    try {
      // `pg_stat_activity` is the whole server, and every connection here is the same superuser, so without
      // `current_database()` this kills the listener of every other worker running its own tests, of a local
      // `yarn dev`, and of any other run sharing the server. Each victim reconnects and publishes a `resync`,
      // dropping the NOTIFYs committed in between — which reads as an unrelated failure somewhere else.
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'dtsse-agent-hub-listener' AND datname = current_database() AND pid <> pg_backend_pid()`
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

describe("a laptop session's registration", () => {
  it("should name the session's chat on the status it announces once the session has one", async () => {
    const caller = { oid: ALICE.oid, tid: "dev", name: ALICE.name, email: ALICE.email };
    const registration = { sessionId: "alices-laptop", name: "alices-laptop", cwd: null, repo: null, branch: null, host: null };

    const { id } = await registerAgent(prisma, caller, registration);
    await registerAgent(prisma, caller, registration);

    // The first registration announces before it links the chat it makes, which nothing lists until the chat has
    // something in it; the second finds the link.
    const expected: HubEvent[] = [
      { type: "agent_status", agent_id: id, owner_oid: ALICE.oid, status: "idle", local_conversation_id: null },
      { type: "agent_status", agent_id: id, owner_oid: ALICE.oid, status: "idle", local_conversation_id: await chatOf(id) }
    ];
    await until(() => pods[0]!.events.length >= expected.length);
    expect(pods[0]!.events).toEqual(expected);
  });
});
