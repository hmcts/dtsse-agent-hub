import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { revokeGrant, setGrant } from "../../src/access/load.ts";
import { heartbeat } from "../../src/agents/store.ts";
import { GET as feed } from "../../src/app/api/ui/feed/route.ts";
import { GET as session } from "../../src/app/api/ui/session/route.ts";
import { GET as stream } from "../../src/app/api/ui/stream/route.ts";
import { GET as topicSuggestions } from "../../src/app/api/ui/topics/route.ts";
import { ackDelivery, createDirect, createPost } from "../../src/messages/store.ts";
import { realtime } from "../../src/realtime/process.ts";
import { devIdentity } from "../../src/viewer/identity.ts";
import { insertAgent, insertUser, type Person, prisma, resetDatabase } from "./database.ts";
import { frames } from "./sse-reader.ts";

function persona(name: string): Person {
  const identity = devIdentity(name);
  return { oid: identity.oid, name: identity.name, email: identity.email! };
}

const ALICE = persona("alice");
const BOB = persona("bob");
const CAROL = persona("carol");

function request(as: string, path: string, signal?: AbortSignal): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, { headers: { cookie: `ah_dev_persona=${as}` }, ...(signal ? { signal } : {}) });
}

const open: { controller: AbortController; reader: ReturnType<typeof frames> }[] = [];

async function watch(as: string, query: string) {
  const controller = new AbortController();
  const response = await stream(request(as, `/api/ui/stream?${query}`, controller.signal));
  expect(response.status).toBe(200);
  const reader = frames(response);
  open.push({ controller, reader });
  await reader.drain(100);
  return reader;
}

let alicesAgent: string;

beforeAll(async () => {
  await realtime().listener.ready();
});

beforeEach(async () => {
  await resetDatabase();
  alicesAgent = await insertAgent(ALICE, "alices-agent");
  await insertUser(BOB);
  await insertUser(CAROL);
  await prisma.agentGrant.create({ data: { ownerOid: ALICE.oid, granteeOid: BOB.oid, level: "read" } });
});

afterEach(async () => {
  for (const { controller, reader } of open.splice(0)) {
    controller.abort();
    await reader.cancel();
  }
});

afterAll(async () => {
  await realtime().listener.stop();
  await prisma.$disconnect();
});

describe("/api/ui/stream", () => {
  it("should send each viewer only the posts, statuses and thread events they may see", async () => {
    const bob = await watch("bob", `topics=pcs-api&agent=${alicesAgent}`);
    const carol = await watch("carol", "topics=pcs-api,database&mode=all");

    await createPost(prisma, { author: { oid: ALICE.oid, agentId: alicesAgent }, topics: ["pcs-api"], title: null, body: "one topic", inReplyTo: null });
    await createPost(prisma, { author: { oid: ALICE.oid, agentId: alicesAgent }, topics: ["ccd"], title: null, body: "elsewhere", inReplyTo: null });
    await createPost(prisma, {
      author: { oid: ALICE.oid, agentId: alicesAgent },
      topics: ["database", "pcs-api"],
      title: null,
      body: "both topics",
      inReplyTo: null
    });
    await heartbeat(prisma, alicesAgent, "busy", null);
    const direct = await createDirect(prisma, { author: { oid: ALICE.oid, agentId: null }, targetAgentId: alicesAgent, inReplyTo: null, body: "from the UI" });
    // The stream loads the message when its NOTIFY arrives, so the ack waits for that; an earlier ack would be read.
    expect(JSON.parse((await bob.named("direct", 1))[0]!.data!).message).toMatchObject({ id: direct.id, body: "from the UI", delivery: "queued" });
    await ackDelivery(prisma, alicesAgent, BigInt(direct.id));

    const bodies = (received: { data?: string }[]) => received.map((frame) => JSON.parse(frame.data!).message.body);
    expect(bodies(await bob.named("post", 2))).toEqual(["one topic", "both topics"]);
    expect((await bob.named("agent_status", 1)).map((frame) => JSON.parse(frame.data!))).toEqual([{ agent_id: alicesAgent, status: "busy" }]);
    expect(JSON.parse((await bob.named("delivery", 1))[0]!.data!)).toEqual({ message_id: direct.id, state: "delivered" });

    expect(bodies(await carol.named("post", 1))).toEqual(["both topics"]);
    await carol.drain();
    expect(carol.received.filter((frame) => frame.event !== undefined).map((frame) => frame.event)).toEqual(["post"]);
  });

  it("should stop sending an agent's thread and status once the grant is revoked", async () => {
    const bob = await watch("bob", `agent=${alicesAgent}`);
    await prisma.agentGrant.deleteMany({});

    await heartbeat(prisma, alicesAgent, "busy", null);
    await createDirect(prisma, { author: { oid: ALICE.oid, agentId: null }, targetAgentId: alicesAgent, inReplyTo: null, body: "secret" });
    await bob.drain(500);

    expect(bob.received.filter((frame) => frame.event !== undefined)).toEqual([]);
  });

  it("should resync and stop sending an agent's thread and status when a grant already read is revoked", async () => {
    const bob = await watch("bob", `agent=${alicesAgent}`);
    await heartbeat(prisma, alicesAgent, "busy", null);
    await bob.named("agent_status", 1);

    await revokeGrant(prisma, ALICE.oid, BOB.oid);
    await heartbeat(prisma, alicesAgent, "idle", null);
    await createDirect(prisma, { author: { oid: ALICE.oid, agentId: null }, targetAgentId: alicesAgent, inReplyTo: null, body: "secret" });
    await bob.drain(500);

    expect(bob.received.filter((frame) => frame.event !== undefined).map((frame) => frame.event)).toEqual(["agent_status", "resync"]);
  });

  it("should resync and start sending an agent's status when the viewer is granted access", async () => {
    const carol = await watch("carol", "");
    await heartbeat(prisma, alicesAgent, "busy", null);
    await carol.drain(300);

    await setGrant(prisma, ALICE.oid, CAROL.oid, "read");
    await heartbeat(prisma, alicesAgent, "idle", null);
    await carol.named("agent_status", 1);

    expect(carol.received.filter((frame) => frame.event !== undefined).map((frame) => frame.event)).toEqual(["resync", "agent_status"]);
  });

  it("should refuse to watch an agent the viewer cannot see, as missing", async () => {
    const response = await stream(request("carol", `/api/ui/stream?agent=${alicesAgent}`));

    expect(response.status).toBe(404);
    expect((await stream(request("carol", "/api/ui/stream?agent=not-an-id"))).status).toBe(404);
  });

  it("should refuse topics that are not slugs", async () => {
    expect((await stream(request("bob", "/api/ui/stream?topics=not%20a%20topic"))).status).toBe(400);
  });

  it("should forward a resync to every open stream when the listener reconnects", async () => {
    const bob = await watch("bob", "");

    realtime().hub.publish({ type: "resync" });

    expect(await bob.named("resync", 1)).toHaveLength(1);
  });
});

describe("/api/ui/feed", () => {
  it("should page back through a channel view with keyset pagination", async () => {
    for (let index = 1; index <= 35; index += 1) {
      await createPost(prisma, { author: { oid: ALICE.oid, agentId: null }, topics: ["a"], title: null, body: `post ${index}`, inReplyTo: null });
    }

    const first = await (await feed(request("bob", "/api/ui/feed?topics=a"))).json();
    const second = await (await feed(request("bob", `/api/ui/feed?topics=a&before=${first.olderBefore}`))).json();

    expect(first.messages).toHaveLength(30);
    expect(first.messages[0].body).toBe("post 6");
    expect(first.messages.at(-1).body).toBe("post 35");
    expect(second.messages.map((message: { body: string }) => message.body)).toEqual(["post 1", "post 2", "post 3", "post 4", "post 5"]);
    expect(second.olderBefore).toBeNull();
  });

  it("should refuse a malformed request", async () => {
    expect((await feed(request("bob", "/api/ui/feed?topics=a&before=x"))).status).toBe(400);
    expect((await feed(request("bob", "/api/ui/feed?topics=A%20B"))).status).toBe(400);
  });
});

describe("/api/ui/topics", () => {
  it("should suggest topics by prefix", async () => {
    await createPost(prisma, { author: { oid: ALICE.oid, agentId: null }, topics: ["pcs-api", "ccd"], title: null, body: "x", inReplyTo: null });

    const body = await (await topicSuggestions(request("bob", "/api/ui/topics?prefix=PC"))).json();

    expect(body.topics.map((topic: { slug: string }) => topic.slug)).toEqual(["pcs-api"]);
  });
});

describe("/api/ui/session", () => {
  it("should answer 204 when there is a viewer", async () => {
    expect((await session(request("bob", "/api/ui/session"))).status).toBe(204);
  });
});

// The proxy lets every `/api/ui/` request through without a session, so each handler is the only thing refusing one.
describe("/api/ui without a session", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_DISABLED", "");
    vi.stubEnv("SESSION_SECRET", "a-test-session-secret-long-enough-to-be-plausible");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["/api/ui/stream", stream],
    ["/api/ui/feed?topics=a", feed],
    ["/api/ui/topics?prefix=p", topicSuggestions],
    ["/api/ui/session", session]
  ])("should answer %s with 401 rather than serve it", async (path, handler) => {
    const response = await handler(new NextRequest(`http://localhost:3000${path}`, { headers: { cookie: "ah_session=expired" } }));

    expect(response.status).toBe(401);
  });
});
