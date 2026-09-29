import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setGrant } from "../../src/access/load.ts";
import { POST as ack } from "../../src/app/api/agent/[agentId]/deliveries/[messageId]/ack/route.ts";
import { POST as direct } from "../../src/app/api/agent/[agentId]/direct/route.ts";
import { POST as posts } from "../../src/app/api/agent/[agentId]/posts/route.ts";
import { GET as stream } from "../../src/app/api/agent/[agentId]/stream/route.ts";
import { GET as agents } from "../../src/app/api/agent/agents/route.ts";
import { GET as messages } from "../../src/app/api/agent/messages/[id]/route.ts";
import { createDirect } from "../../src/messages/store.ts";
import { realtime } from "../../src/realtime/process.ts";
import { byCodePoint } from "../../src/topics/slug.ts";
import { insertAgent, insertUser, type Person, person, prisma, resetDatabase } from "./database.ts";
import { call, jsonOf } from "./routes.ts";
import { frames } from "./sse-reader.ts";

const ALICE = person("alice");
const BOB = person("bob");
const CAROL = person("carol");

let alicesAgent: string;
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
  bobsAgent = await insertAgent(BOB, "bob-ccd");
  await insertUser(CAROL);
});

afterAll(async () => {
  await realtime().listener.stop();
  await prisma.$disconnect();
});

describe("direct messages", () => {
  it("should refuse a direct message to someone else's agent without a write grant", async () => {
    const response = await send(ALICE, alicesAgent, { to_agent: bobsAgent, body: "hello" });

    expect(response.status).toBe(403);
  });

  it("should refuse with a read grant and allow with a write grant", async () => {
    await setGrant(prisma, BOB.oid, ALICE.oid, "read");
    expect((await send(ALICE, alicesAgent, { to_agent: "bob-ccd", body: "hello" })).status).toBe(404);

    await setGrant(prisma, BOB.oid, ALICE.oid, "write");
    const response = await send(ALICE, alicesAgent, { to_agent: "bob-ccd", body: "hello" });

    expect(response.status).toBe(201);
    const { message } = await jsonOf(response);
    expect(message).toMatchObject({ kind: "direct", topics: [], title: null, target_agent_id: bobsAgent, author: { agent_id: alicesAgent } });
    expect(await prisma.delivery.findFirstOrThrow()).toMatchObject({ agentId: bobsAgent, state: "queued", deliveredAt: null });
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

  it("should route a reply to a received direct message back to its author, even without the reverse grant", async () => {
    await setGrant(prisma, BOB.oid, ALICE.oid, "write");
    const { message: original } = await jsonOf(await send(ALICE, alicesAgent, { to_agent: bobsAgent, body: "question" }));

    const response = await send(BOB, bobsAgent, { reply_to_message: original.id, body: "answer" });

    expect(response.status).toBe(201);
    expect((await jsonOf(response)).message).toMatchObject({ target_agent_id: alicesAgent, in_reply_to: original.id });
  });

  it("should route a reply to a person's message into the agent's own thread, readable by that person", async () => {
    await setGrant(prisma, ALICE.oid, CAROL.oid, "write");
    const fromCarol = await createDirect(prisma, {
      author: { oid: CAROL.oid, agentId: null },
      targetAgentId: alicesAgent,
      inReplyTo: null,
      body: "from the UI"
    });

    const { message: reply } = await jsonOf(await send(ALICE, alicesAgent, { reply_to_message: fromCarol.id, body: "on it" }));

    expect(reply).toMatchObject({ target_agent_id: null, in_reply_to: fromCarol.id });
    expect((await call(messages, { as: CAROL, path: "", params: { id: reply.id } })).status).toBe(200);
    expect((await call(messages, { as: BOB, path: "", params: { id: reply.id } })).status).toBe(403);
  });

  it("should route a private reply to another owner's post through the ordinary grant", async () => {
    const created = await call(posts, { as: BOB, path: "", method: "POST", params: { agentId: bobsAgent }, body: { topics: ["ccd"], body: "a finding" } });
    const { message: post } = await jsonOf(created);

    expect((await send(ALICE, alicesAgent, { reply_to_message: post.id, body: "tell me more" })).status).toBe(403);

    await setGrant(prisma, BOB.oid, ALICE.oid, "write");
    const reply = await send(ALICE, alicesAgent, { reply_to_message: post.id, body: "tell me more" });
    expect(reply.status).toBe(201);
    expect((await jsonOf(reply)).message).toMatchObject({ kind: "direct", target_agent_id: bobsAgent, in_reply_to: post.id });
  });

  it("should give 404 for a reply to a message that does not exist", async () => {
    expect((await send(ALICE, alicesAgent, { reply_to_message: "424242", body: "x" })).status).toBe(404);
  });

  it("should list only the agents the caller may message", async () => {
    await setGrant(prisma, BOB.oid, CAROL.oid, "read");
    const carolsView = await jsonOf(await call(agents, { as: CAROL, path: "/api/agent/agents" }));
    expect(carolsView.agents).toEqual([]);

    await setGrant(prisma, BOB.oid, CAROL.oid, "write");
    const { agents: listed } = await jsonOf(await call(agents, { as: CAROL, path: "/api/agent/agents" }));
    expect(listed).toEqual([expect.objectContaining({ id: bobsAgent, name: "bob-ccd", status: "idle", owner: { name: BOB.name, email: BOB.email } })]);
  });

  it("should let only the sender, the target's owner and the target's grantees read a direct message", async () => {
    await setGrant(prisma, BOB.oid, ALICE.oid, "write");
    const { message } = await jsonOf(await send(ALICE, alicesAgent, { to_agent: bobsAgent, body: "private" }));
    const read = async (as: Person) => (await call(messages, { as, path: "", params: { id: message.id } })).status;

    expect(await read(ALICE)).toBe(200);
    expect(await read(BOB)).toBe(200);
    expect(await read(CAROL)).toBe(403);
    await setGrant(prisma, BOB.oid, CAROL.oid, "read");
    expect(await read(CAROL)).toBe(200);
    expect((await call(messages, { as: CAROL, path: "", params: { id: "999999" } })).status).toBe(404);
  });
});

describe("the agent stream", () => {
  it("should replay queued deliveries on connect, stream new ones live, and stop resending once acked", async () => {
    await setGrant(prisma, BOB.oid, ALICE.oid, "write");
    const { message: queued } = await jsonOf(await send(ALICE, alicesAgent, { to_agent: bobsAgent, body: "sent while offline" }));

    const first = openStream(BOB, bobsAgent);
    const response = await first.response;
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = frames(response);

    const replayed = await reader.directs(1);
    expect(replayed).toEqual([{ id: queued.id, message: expect.objectContaining({ id: queued.id, body: "sent while offline" }) }]);

    const { message: live } = await jsonOf(await send(ALICE, alicesAgent, { to_agent: bobsAgent, body: "sent while connected" }));
    const both = await reader.directs(2);
    expect(both.map((event) => event.id)).toEqual([queued.id, live.id]);

    const acked = await call(ack, { as: BOB, path: "", method: "POST", params: { agentId: bobsAgent, messageId: queued.id } });
    expect(acked.status).toBe(204);
    expect(await prisma.delivery.findFirstOrThrow({ where: { messageId: BigInt(queued.id) } })).toMatchObject({ state: "delivered" });
    first.abort.abort();
    await reader.cancel();

    const second = openStream(BOB, bobsAgent);
    const again = frames(await second.response);
    expect((await again.directs(1)).map((event) => event.id)).toEqual([live.id]);
    second.abort.abort();
    await again.cancel();
  });

  it("should not send another agent's direct messages", async () => {
    const carolsAgent = await insertAgent(CAROL, "carol-agent");
    await setGrant(prisma, CAROL.oid, ALICE.oid, "write");
    const opened = openStream(BOB, bobsAgent);
    const reader = frames(await opened.response);

    await send(ALICE, alicesAgent, { to_agent: carolsAgent, body: "for carol" });

    await expect(reader.directs(1, 1000)).rejects.toThrow(/got 0/);
    opened.abort.abort();
    await reader.cancel();
  });

  it("should refuse to stream someone else's agent", async () => {
    expect((await openStream(ALICE, bobsAgent).response).status).toBe(403);
  });

  it("should answer an ack for a message the agent never received with 404, and a repeated ack with 204", async () => {
    await setGrant(prisma, BOB.oid, ALICE.oid, "write");
    const { message } = await jsonOf(await send(ALICE, alicesAgent, { to_agent: bobsAgent, body: "x" }));
    const acking = (agentId: string, as: Person) => call(ack, { as, path: "", method: "POST", params: { agentId, messageId: message.id } });

    expect((await acking(alicesAgent, ALICE)).status).toBe(404);
    expect((await acking(bobsAgent, BOB)).status).toBe(204);
    expect((await acking(bobsAgent, BOB)).status).toBe(204);
  });
});
