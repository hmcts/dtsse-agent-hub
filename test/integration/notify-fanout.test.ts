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

/** Puts the agent's chat in the sidebar, as its first words would (`announceFirstContent`), and answers its id. */
async function listed(agentId: string): Promise<string> {
  const chat = (await chatOf(agentId))!;
  await prisma.assistantConversation.update({ where: { id: chat }, data: { firstContentAt: new Date() } });
  return chat;
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
    expect(pods[0]!.events).toEqual([{ type: "agent_status", agent_id: agent, owner_oid: ALICE.oid, status: "busy", local_conversation_id: null }]);
  });

  it("should name a listed laptop chat on every status its current session announces, and no chat for any other agent", async () => {
    const hourAgo = new Date(Date.now() - 3_600_000);
    const laptop = await settled(await insertAgent(ALICE, "laptop"), ALICE.oid, "laptop");
    const laptopChat = await listed(laptop);
    const stale = await settled(await insertAgent(ALICE, "stale", { status: "busy", lastHeartbeatAt: hourAgo }), ALICE.oid, "stale");
    const staleChat = await listed(stale);
    // Still linked to the laptop's chat, but the chat's current agent is the laptop, so this one's mark is not drawn.
    const movedOn = await insertAgent(ALICE, "moved-on", { status: "busy", lastHeartbeatAt: hourAgo });
    await prisma.agent.update({ where: { id: movedOn }, data: { assistantConversationId: laptopChat } });
    const unlisted = await settled(await insertAgent(ALICE, "unlisted"), ALICE.oid, "unlisted");
    const pod = await insertAgent(ALICE, "pod");
    const assistant = await prisma.virtualAgent.create({ data: { ownerOid: ALICE.oid, name: "assistant", modelRoute: "gateway" }, select: { id: true } });
    const chat = await prisma.assistantConversation.create({
      data: { ownerOid: ALICE.oid, virtualAgentId: assistant.id, agentId: pod, firstContentAt: new Date() },
      select: { id: true }
    });
    await prisma.agent.update({ where: { id: pod }, data: { assistantConversationId: chat.id, virtualAgentId: assistant.id } });

    await heartbeat(prisma, laptop, "busy", null);
    await heartbeat(prisma, unlisted, "busy", null);
    await heartbeat(prisma, pod, "busy", null);
    await markOffline(prisma, laptop);
    await sweepOffline(prisma);

    const expected: HubEvent[] = [
      { type: "agent_status", agent_id: laptop, owner_oid: ALICE.oid, status: "busy", local_conversation_id: laptopChat },
      { type: "agent_status", agent_id: unlisted, owner_oid: ALICE.oid, status: "busy", local_conversation_id: null },
      { type: "agent_status", agent_id: pod, owner_oid: ALICE.oid, status: "busy", local_conversation_id: null },
      { type: "agent_status", agent_id: laptop, owner_oid: ALICE.oid, status: "offline", local_conversation_id: laptopChat }
    ];
    // The sweep's order is the UPDATE's, which is not defined, so its two are compared as a set.
    const swept: HubEvent[] = [
      { type: "agent_status", agent_id: stale, owner_oid: ALICE.oid, status: "offline", local_conversation_id: staleChat },
      { type: "agent_status", agent_id: movedOn, owner_oid: ALICE.oid, status: "offline", local_conversation_id: null }
    ];
    await until(() => pods[0]!.events.length >= expected.length + swept.length);
    expect(pods[0]!.events.slice(0, expected.length)).toEqual(expected);
    expect(pods[0]!.events.slice(expected.length)).toEqual(expect.arrayContaining(swept));
    expect(pods[0]!.events).toHaveLength(expected.length + swept.length);
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
    expect(pods[0]!.events).toEqual([{ type: "agent_status", agent_id: agent, owner_oid: ALICE.oid, status: "busy", local_conversation_id: null }]);
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

// The status a registration or heartbeat announces is read before it links a new chat, and is the same read after:
// the chat it links is empty, so it is not in the sidebar yet and is named on the first status after it is listed.
describe("a status announced with a newly linked chat", () => {
  it("should name no chat for a registration that links one, and the chat once it is listed", async () => {
    const caller = { oid: ALICE.oid, tid: "dev", name: ALICE.name, email: ALICE.email };
    const registration = { sessionId: "alices-laptop", name: "alices-laptop", cwd: null, repo: null, branch: null, host: null };

    const { id } = await registerAgent(prisma, caller, registration);
    expect(await chatOf(id)).not.toBeNull();
    const chat = await listed(id);
    await registerAgent(prisma, caller, registration);

    const expected: HubEvent[] = [
      { type: "agent_status", agent_id: id, owner_oid: ALICE.oid, status: "idle", local_conversation_id: null, registered: true },
      { type: "agent_status", agent_id: id, owner_oid: ALICE.oid, status: "idle", local_conversation_id: chat, registered: true }
    ];
    await until(() => pods[0]!.events.length >= expected.length);
    expect(pods[0]!.events).toEqual(expected);
  });

  it("should name no chat for a heartbeat that links one, and the chat once it is listed", async () => {
    const agent = await insertAgent(ALICE, "laptop");

    await heartbeat(prisma, agent, "busy", null);
    expect(await chatOf(agent)).not.toBeNull();
    const chat = await listed(agent);
    await heartbeat(prisma, agent, "idle", null);

    const expected: HubEvent[] = [
      { type: "agent_status", agent_id: agent, owner_oid: ALICE.oid, status: "busy", local_conversation_id: null },
      { type: "agent_status", agent_id: agent, owner_oid: ALICE.oid, status: "idle", local_conversation_id: chat }
    ];
    await until(() => pods[0]!.events.length >= expected.length);
    expect(pods[0]!.events).toEqual(expected);
  });
});
