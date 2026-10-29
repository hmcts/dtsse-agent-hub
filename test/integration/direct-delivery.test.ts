import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as ack } from "../../src/app/api/agent/[agentId]/deliveries/[messageId]/ack/route.ts";
import { POST as direct } from "../../src/app/api/agent/[agentId]/direct/route.ts";
import { POST as posts } from "../../src/app/api/agent/[agentId]/posts/route.ts";
import { GET as stream } from "../../src/app/api/agent/[agentId]/stream/route.ts";
import { GET as agents } from "../../src/app/api/agent/agents/route.ts";
import { GET as messages } from "../../src/app/api/agent/messages/[id]/route.ts";
import { createDirect } from "../../src/messages/store.ts";
import { realtime } from "../../src/realtime/process.ts";
import { MIN_STREAM_MAX_SECONDS, RECONNECT_AFTER_MS } from "../../src/realtime/sse.ts";
import { streamLimits } from "../../src/realtime/stream-slots.ts";
import { byCodePoint } from "../../src/topics/slug.ts";
import { insertAgent, insertUser, type Person, person, prisma, resetDatabase } from "./database.ts";
import { call, jsonOf } from "./routes.ts";
import { frames } from "./sse-reader.ts";

const ALICE = person("alice");
const BOB = person("bob");
const CAROL = person("carol");

let alicesAgent: string;
/** A second agent of Alice's. A direct message is between one person's sessions, so this is the usual target. */
let alicesOther: string;
let bobsAgent: string;

async function send(as: Person, from: string, body: Record<string, unknown>): Promise<Response> {
  return await call(direct, { as, path: `/api/agent/${from}/direct`, method: "POST", params: { agentId: from }, body });
}

function openStream(as: Person, agentId: string) {
  const abort = new AbortController();
  const response = call(stream, {
    as,
    path: `/api/agent/${agentId}/stream`,
    params: { agentId },
    signal: abort.signal,
    headers: { accept: "text/event-stream" }
  });
  return { abort, response };
}

beforeAll(async () => {
  await realtime().listener.ready();
});

beforeEach(async () => {
  await resetDatabase();
  alicesAgent = await insertAgent(ALICE, "alice-pcs-api");
  alicesOther = await insertAgent(ALICE, "alice-ccd");
  bobsAgent = await insertAgent(BOB, "bob-ccd");
  await insertUser(CAROL);
});

afterAll(async () => {
  await realtime().listener.stop();
  await prisma.$disconnect();
});

describe("direct messages", () => {
  it("should refuse a direct message to someone else's agent by id, and say what reaches it instead", async () => {
    const response = await send(ALICE, alicesAgent, { to_agent: bobsAgent, body: "hello" });

    expect(response.status).toBe(403);
    expect((await jsonOf(response)).error).toMatch(/tag that agent/);
  });

  it("should report someone else's agent as missing when it is named rather than identified", async () => {
    expect((await send(ALICE, alicesAgent, { to_agent: "bob-ccd", body: "hello" })).status).toBe(404);
  });

  // The case that has to keep working: one of a person's sessions messaging another.
  it("should deliver a direct message to another agent of the same owner, by name", async () => {
    const response = await send(ALICE, alicesAgent, { to_agent: "alice-ccd", body: "hello" });

    expect(response.status).toBe(201);
    const { message } = await jsonOf(response);
    expect(message).toMatchObject({ kind: "direct", topics: [], title: null, target_agent_id: alicesOther, author: { agent_id: alicesAgent } });
    expect(await prisma.delivery.findFirstOrThrow()).toMatchObject({ agentId: alicesOther, state: "queued", deliveredAt: null });
  });

  it("should answer an ambiguous name with 409 and the candidates, preferring live agents over offline ones", async () => {
    await insertAgent(ALICE, "twin", { status: "offline" });
    const first = await insertAgent(ALICE, "twin");
    expect(await jsonOf(await send(ALICE, alicesAgent, { to_agent: "twin", body: "x" }))).toMatchObject({ message: { target_agent_id: first } });

    const second = await insertAgent(ALICE, "twin", { status: "busy", repo: "pcs-api", branch: "HDPI-1", lastHeartbeatAt: new Date("2026-09-29T10:00:00Z") });
    const response = await send(ALICE, alicesAgent, { to_agent: "twin", body: "x" });

    expect(response.status).toBe(409);
    const body = await jsonOf(response);
    expect(body.error).toMatch(/more than one/);
    expect(body.candidates.map((candidate: { id: string }) => candidate.id).sort(byCodePoint)).toEqual([first, second].sort(byCodePoint));
    expect(body.candidates[0]).toMatchObject({ name: "twin", owner_name: ALICE.name });
    expect(body.candidates.find((candidate: { id: string }) => candidate.id === second)).toEqual({
      id: second,
      name: "twin",
      status: "busy",
      repo: "pcs-api",
      branch: "HDPI-1",
      last_heartbeat_at: "2026-09-29T10:00:00.000Z",
      owner_name: ALICE.name
    });
    expect(body.candidates.find((candidate: { id: string }) => candidate.id === first)).toMatchObject({ status: "idle", repo: null, branch: null });
  });

  // The other case that has to keep working. The row is written through the store rather than sent: the only way a
  // direct crosses between two owners' agents now is this reply, so nothing could have sent the one it answers. A
  // row written before the owner-wide access went looks exactly like this, and an agent must still be able to answer
  // one. Alice reached Bob's agent, so Bob's agent may answer whatever Alice holds.
  it("should route a reply to a received direct message back to its author, whoever owns the sender", async () => {
    const original = await createDirect(prisma, {
      author: { oid: ALICE.oid, agentId: alicesAgent },
      targetAgentId: bobsAgent,
      inReplyTo: null,
      body: "question"
    });

    const response = await send(BOB, bobsAgent, { reply_to_message: original.id, body: "answer" });

    expect(response.status).toBe(201);
    expect((await jsonOf(response)).message).toMatchObject({ target_agent_id: alicesAgent, in_reply_to: original.id });
  });

  it("should route a reply to a person's message into the agent's own thread, readable by that person", async () => {
    const fromAlice = await createDirect(prisma, {
      author: { oid: ALICE.oid, agentId: null },
      targetAgentId: alicesAgent,
      inReplyTo: null,
      body: "from the UI"
    });

    const { message: reply } = await jsonOf(await send(ALICE, alicesAgent, { reply_to_message: fromAlice.id, body: "on it" }));

    expect(reply).toMatchObject({ target_agent_id: null, in_reply_to: fromAlice.id });
    expect((await call(messages, { as: ALICE, path: "", params: { id: reply.id } })).status).toBe(200);
    expect((await call(messages, { as: BOB, path: "", params: { id: reply.id } })).status).toBe(403);
  });

  it("should route a private reply to this owner's own agent's post to that agent", async () => {
    const created = await call(posts, {
      as: ALICE,
      path: "",
      method: "POST",
      params: { agentId: alicesOther },
      body: { topics: ["ccd"], body: "a finding" }
    });
    const { message: post } = await jsonOf(created);

    const reply = await send(ALICE, alicesAgent, { reply_to_message: post.id, body: "tell me more" });

    expect(reply.status).toBe(201);
    expect((await jsonOf(reply)).message).toMatchObject({ kind: "direct", target_agent_id: alicesOther, in_reply_to: post.id });
  });

  // The answer goes on the board rather than into a thread only two agents can read.
  it("should refuse a private reply to another owner's post and name the post that replaces it", async () => {
    const created = await call(posts, { as: BOB, path: "", method: "POST", params: { agentId: bobsAgent }, body: { topics: ["ccd"], body: "a finding" } });
    const { message: post } = await jsonOf(created);

    const response = await send(ALICE, alicesAgent, { reply_to_message: post.id, body: "tell me more" });

    expect(response.status).toBe(403);
    expect((await jsonOf(response)).error).toMatch(/post on the topic and tag that agent/);
  });

  it("should give 404 for a reply to a message that does not exist", async () => {
    expect((await send(ALICE, alicesAgent, { reply_to_message: "424242", body: "x" })).status).toBe(404);
  });

  it("should list the caller's own agents and nobody else's", async () => {
    const carolsView = await jsonOf(await call(agents, { as: CAROL, path: "/api/agent/agents" }));
    expect(carolsView.agents).toEqual([]);

    const { agents: listed } = await jsonOf(await call(agents, { as: BOB, path: "/api/agent/agents" }));
    expect(listed).toEqual([expect.objectContaining({ id: bobsAgent, name: "bob-ccd", status: "idle", owner: { name: BOB.name, email: BOB.email } })]);
  });

  it("should let the sender and the thread's owner read a direct message, and nobody else", async () => {
    const { message } = await jsonOf(await send(ALICE, alicesAgent, { to_agent: alicesOther, body: "private" }));
    const read = async (as: Person) => (await call(messages, { as, path: "", params: { id: message.id } })).status;

    expect(await read(ALICE)).toBe(200);
    expect(await read(BOB)).toBe(403);
    expect(await read(CAROL)).toBe(403);
    expect((await call(messages, { as: CAROL, path: "", params: { id: "999999" } })).status).toBe(404);
  });
});

describe("the agent stream", () => {
  it("should replay queued deliveries on connect, stream new ones live, and stop resending once acked", async () => {
    const { message: queued } = await jsonOf(await send(ALICE, alicesAgent, { to_agent: alicesOther, body: "sent while offline" }));

    const first = openStream(ALICE, alicesOther);
    const response = await first.response;
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = frames(response);

    const replayed = await reader.directs(1);
    expect(replayed).toEqual([{ id: queued.id, message: expect.objectContaining({ id: queued.id, body: "sent while offline" }) }]);

    const { message: live } = await jsonOf(await send(ALICE, alicesAgent, { to_agent: alicesOther, body: "sent while connected" }));
    const both = await reader.directs(2);
    expect(both.map((event) => event.id)).toEqual([queued.id, live.id]);

    const acked = await call(ack, { as: ALICE, path: "", method: "POST", params: { agentId: alicesOther, messageId: queued.id } });
    expect(acked.status).toBe(204);
    expect(await prisma.delivery.findFirstOrThrow({ where: { messageId: BigInt(queued.id) } })).toMatchObject({ state: "delivered" });
    first.abort.abort();
    await reader.cancel();

    const second = openStream(ALICE, alicesOther);
    const again = frames(await second.response);
    expect((await again.directs(1)).map((event) => event.id)).toEqual([live.id]);
    second.abort.abort();
    await again.cancel();
  });

  describe("at its lifetime", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("should end with a reconnect event and give its slot back, and the next connection should replay a message sent in between", async () => {
      vi.stubEnv("STREAM_MAX_SECONDS", String(MIN_STREAM_MAX_SECONDS));
      const opened = Date.now();
      const first = openStream(ALICE, alicesOther);
      const ended = await frames(await first.response).end();
      const lastedMs = Date.now() - opened;

      expect(ended[0]).toEqual({ comment: "connected" });
      expect(ended[1]).toEqual({ retry: String(RECONNECT_AFTER_MS) });
      expect(ended.at(-1)).toEqual({ event: "reconnect", data: "{}" });
      expect(lastedMs).toBeGreaterThanOrEqual(MIN_STREAM_MAX_SECONDS * 900);
      expect(lastedMs).toBeLessThan(MIN_STREAM_MAX_SECONDS * 1000 + 2000);
      expect(streamLimits().agent.held(ALICE.oid)).toBe(0);

      const { message: between } = await jsonOf(await send(ALICE, alicesAgent, { to_agent: alicesOther, body: "sent between streams" }));
      const second = openStream(ALICE, alicesOther);
      const reader = frames(await second.response);

      expect(await reader.directs(1)).toEqual([{ id: between.id, message: expect.objectContaining({ body: "sent between streams" }) }]);
      second.abort.abort();
      await reader.cancel();
    });
  });

  it("should not send another agent's direct messages", async () => {
    const alicesThird = await insertAgent(ALICE, "alice-third");
    const opened = openStream(ALICE, alicesOther);
    const reader = frames(await opened.response);

    await send(ALICE, alicesAgent, { to_agent: alicesThird, body: "for the third" });

    await expect(reader.directs(1, 1000)).rejects.toThrow(/got 0/);
    opened.abort.abort();
    await reader.cancel();
  });

  it("should refuse to stream someone else's agent", async () => {
    expect((await openStream(ALICE, bobsAgent).response).status).toBe(403);
  });

  it("should answer an ack for a message the agent never received with 404, and a repeated ack with 204", async () => {
    const { message } = await jsonOf(await send(ALICE, alicesAgent, { to_agent: alicesOther, body: "x" }));
    const acking = (agentId: string, as: Person) => call(ack, { as, path: "", method: "POST", params: { agentId, messageId: message.id } });

    expect((await acking(alicesAgent, ALICE)).status).toBe(404);
    expect((await acking(alicesOther, ALICE)).status).toBe(204);
    expect((await acking(alicesOther, ALICE)).status).toBe(204);
  });
});
