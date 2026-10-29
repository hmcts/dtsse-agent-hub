import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as ack } from "../../src/app/api/agent/[agentId]/deliveries/[messageId]/ack/route.ts";
import { GET as feed } from "../../src/app/api/agent/[agentId]/feed/route.ts";
import { POST as posts } from "../../src/app/api/agent/[agentId]/posts/route.ts";
import { GET as stream } from "../../src/app/api/agent/[agentId]/stream/route.ts";
import { PUT as subscribe } from "../../src/app/api/agent/[agentId]/subscriptions/route.ts";
import { GET as messages } from "../../src/app/api/agent/messages/[id]/route.ts";
import { GET as topicMessages } from "../../src/app/api/agent/topics/[slug]/messages/route.ts";
import { createConversation, ensureAssistant } from "../../src/assistant/store.ts";
import { MAX_POST_TAGS } from "../../src/messages/tags.ts";
import { realtime } from "../../src/realtime/process.ts";
import { byCodePoint } from "../../src/topics/slug.ts";
import { insertAgent, insertUser, type Person, person, prisma, resetDatabase } from "./database.ts";
import { call, jsonOf } from "./routes.ts";
import { frames } from "./sse-reader.ts";

/**
 * Tagging an agent in a post, which is the only way one agent reaches another owner's session: the post stays a
 * post, and each tagged agent is queued the delivery its stream sends. See "Tagging agents" in `docs/agent-api.md`.
 */

const ALICE = person("alice");
const BOB = person("bob");
const CAROL = person("carol");

let alicesAgent: string;
let bobsAgent: string;

async function post(as: Person, from: string, body: Record<string, unknown>): Promise<Response> {
  return await call(posts, { as, path: `/api/agent/${from}/posts`, method: "POST", params: { agentId: from }, body });
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

describe("a tagged post", () => {
  it("should reach an agent of another owner that subscribes to none of its topics, with nothing between them", async () => {
    const opened = openStream(BOB, bobsAgent);
    const reader = frames(await opened.response);

    const created = await post(ALICE, alicesAgent, { topics: ["pcs-api"], title: "Over to you", body: "your turn", tag_agents: ["bob-ccd"] });

    expect(created.status).toBe(201);
    const { message } = await jsonOf(created);
    expect(message).toMatchObject({ kind: "post", topics: ["pcs-api"], tagged_agents: [{ id: bobsAgent, name: "bob-ccd" }] });
    expect(await reader.directs(1)).toEqual([
      { id: message.id, message: expect.objectContaining({ id: message.id, kind: "post", title: "Over to you", topics: ["pcs-api"] }) }
    ]);
    expect(await prisma.messageTag.findMany({ where: { messageId: BigInt(message.id) } })).toEqual([{ messageId: BigInt(message.id), agentId: bobsAgent }]);
    expect(await prisma.delivery.findFirstOrThrow({ where: { messageId: BigInt(message.id) } })).toMatchObject({ agentId: bobsAgent, state: "queued" });

    opened.abort.abort();
    await reader.cancel();
  });

  it("should replay on a reconnection until it is acked, and stop once it is", async () => {
    const { message } = await jsonOf(await post(ALICE, alicesAgent, { topics: ["pcs-api"], body: "first", tag_agents: [bobsAgent] }));

    const first = openStream(BOB, bobsAgent);
    const reading = frames(await first.response);
    expect((await reading.directs(1)).map((frame) => frame.id)).toEqual([message.id]);
    first.abort.abort();
    await reading.cancel();

    const second = openStream(BOB, bobsAgent);
    const again = frames(await second.response);
    expect((await again.directs(1)).map((frame) => frame.id)).toEqual([message.id]);
    expect((await call(ack, { as: BOB, path: "", method: "POST", params: { agentId: bobsAgent, messageId: message.id } })).status).toBe(204);
    second.abort.abort();
    await again.cancel();

    const third = openStream(BOB, bobsAgent);
    const last = frames(await third.response);
    await last.drain();
    expect(last.received.filter((frame) => frame.event === "direct")).toEqual([]);
    third.abort.abort();
    await last.cancel();
  });

  it("should still be a post on its topics, readable by anyone and in a subscriber's feed", async () => {
    const { message } = await jsonOf(await post(ALICE, alicesAgent, { topics: ["pcs-api"], body: "a finding", tag_agents: [bobsAgent] }));

    const read = await call(messages, { as: CAROL, path: "", params: { id: message.id } });
    expect(read.status).toBe(200);
    expect((await jsonOf(read)).message).toMatchObject({ tagged_agents: [{ id: bobsAgent, name: "bob-ccd" }] });

    const onTopic = await jsonOf(await call(topicMessages, { as: CAROL, path: "/api/agent/topics/pcs-api/messages", params: { slug: "pcs-api" } }));
    expect(onTopic.messages.map((entry: { id: string }) => entry.id)).toEqual([message.id]);

    await call(subscribe, { as: BOB, path: "", method: "PUT", params: { agentId: bobsAgent }, body: { topics: ["pcs-api"] } });
    const bobsFeed = await jsonOf(await call(feed, { as: BOB, path: `/api/agent/${bobsAgent}/feed?since=0`, params: { agentId: bobsAgent } }));
    expect(bobsFeed.messages.map((entry: { id: string }) => entry.id)).toEqual([message.id]);
  });

  it("should queue for a tagged agent that is offline, and be acked when it comes back", async () => {
    const sleeping = await insertAgent(BOB, "bob-asleep", { status: "offline" });

    const { message } = await jsonOf(await post(ALICE, alicesAgent, { topics: ["pcs-api"], body: "when you wake", tag_agents: ["bob-asleep"] }));
    expect(await prisma.delivery.findFirstOrThrow({ where: { messageId: BigInt(message.id) } })).toMatchObject({ agentId: sleeping, state: "queued" });

    const opened = openStream(BOB, sleeping);
    const reader = frames(await opened.response);
    expect((await reader.directs(1)).map((frame) => frame.id)).toEqual([message.id]);
    expect((await call(ack, { as: BOB, path: "", method: "POST", params: { agentId: sleeping, messageId: message.id } })).status).toBe(204);

    expect(await prisma.delivery.findFirstOrThrow({ where: { messageId: BigInt(message.id) } })).toMatchObject({ state: "delivered" });
    opened.abort.abort();
    await reader.cancel();
  });

  it("should reach every agent it tags, each with its own delivery", async () => {
    const carolsAgent = await insertAgent(CAROL, "carol-wa");

    const { message } = await jsonOf(await post(ALICE, alicesAgent, { topics: ["pcs-api"], body: "both of you", tag_agents: ["bob-ccd", carolsAgent] }));

    expect(message.tagged_agents.map((agent: { name: string }) => agent.name)).toEqual(["bob-ccd", "carol-wa"]);
    const queued = await prisma.delivery.findMany({ where: { messageId: BigInt(message.id) }, select: { agentId: true } });
    expect(queued.map((delivery) => delivery.agentId).sort(byCodePoint)).toEqual([bobsAgent, carolsAgent].sort(byCodePoint));
  });

  it("should count two references to one agent once", async () => {
    const { message } = await jsonOf(await post(ALICE, alicesAgent, { topics: ["pcs-api"], body: "once", tag_agents: ["bob-ccd", bobsAgent, "@bob-ccd"] }));

    expect(message.tagged_agents).toEqual([{ id: bobsAgent, name: "bob-ccd" }]);
    expect(await prisma.delivery.count({ where: { messageId: BigInt(message.id) } })).toBe(1);
  });
});

describe("a post the hub refuses to tag", () => {
  async function refusal(body: Record<string, unknown>): Promise<{ status: number; error: string; candidates?: { id: string }[] }> {
    const response = await post(ALICE, alicesAgent, { topics: ["pcs-api"], title: "Refused", body: "x", ...body });
    const answer = await jsonOf(response);
    return { status: response.status, error: answer.error, candidates: answer.candidates };
  }

  async function nothingWritten(): Promise<void> {
    expect(await prisma.message.count()).toBe(0);
    expect(await prisma.delivery.count()).toBe(0);
    expect(await prisma.messageTag.count()).toBe(0);
    expect(await prisma.topic.count()).toBe(0);
  }

  it("should refuse the whole post, writing nothing, when a name matches no agent", async () => {
    const refused = await refusal({ tag_agents: ["bob-ccd", "nobody-here"] });

    expect(refused.status).toBe(404);
    expect(refused.error).toBe('no agent is called "nobody-here"');
    await nothingWritten();
  });

  it("should refuse an id that is not an agent's, saying only that there is no such agent", async () => {
    const refused = await refusal({ tag_agents: ["11111111-1111-4111-8111-111111111111"] });

    expect(refused.status).toBe(404);
    expect(refused.error).toBe("no such agent");
    await nothingWritten();
  });

  it("should refuse a name two live agents share with the candidates to choose from", async () => {
    const first = await insertAgent(BOB, "twin");
    const second = await insertAgent(CAROL, "twin", { status: "busy", repo: "pcs-api", branch: "HDPI-1" });

    const refused = await refusal({ tag_agents: ["twin"] });

    expect(refused.status).toBe(409);
    expect(refused.error).toMatch(/more than one agent is called "twin"/);
    expect((refused.candidates ?? []).map((candidate) => candidate.id).sort(byCodePoint)).toEqual([first, second].sort(byCodePoint));
    // A name and whose it is, and nothing about what the session is doing. Carol's agent is somebody else's and the
    // refusal writes nothing, so a wider shape here would be a free, repeatable probe for other owners' work.
    expect(Object.keys((refused.candidates ?? [])[0] ?? {}).sort(byCodePoint)).toEqual(["id", "name", "owner_name"]);
    expect(await prisma.message.count()).toBe(0);
  });

  it("should refuse an agent tagging itself", async () => {
    const refused = await refusal({ tag_agents: ["alice-pcs-api"] });

    expect(refused.status).toBe(400);
    expect(refused.error).toBe("an agent cannot tag itself in its own post");
    await nothingWritten();
  });

  it("should refuse more than the cap, counting distinct references", async () => {
    for (let index = 0; index <= MAX_POST_TAGS; index++) {
      await insertAgent(CAROL, `many-${index}`);
    }
    const names = Array.from({ length: MAX_POST_TAGS + 1 }, (_value, index) => `many-${index}`);

    const over = await refusal({ tag_agents: names });
    expect(over.status).toBe(400);
    expect(over.error).toBe(`a post tags at most ${MAX_POST_TAGS} agents, and this one tags ${MAX_POST_TAGS + 1}`);
    expect(await prisma.message.count()).toBe(0);

    const atTheCap = await post(ALICE, alicesAgent, { topics: ["pcs-api"], body: "ten", tag_agents: names.slice(0, MAX_POST_TAGS) });
    expect(atTheCap.status).toBe(201);
    expect((await jsonOf(atTheCap)).message.tagged_agents).toHaveLength(MAX_POST_TAGS);
  });

  it("should refuse an assistant conversation's agent, to its owner as to anyone", async () => {
    await ensureAssistant(prisma, { oid: ALICE.oid, modelRoute: "gateway" });
    const conversation = await createConversation(prisma, ALICE.oid, { product: "general" });
    const chatAgent = conversation.agentId!;
    const chatName = (await prisma.agent.findUniqueOrThrow({ where: { id: chatAgent }, select: { name: true } })).name;

    const byId = await refusal({ tag_agents: [chatAgent] });
    const byName = await refusal({ tag_agents: [chatName] });
    const byItsOwner = await call(posts, {
      as: ALICE,
      path: "",
      method: "POST",
      params: { agentId: alicesAgent },
      body: { topics: ["pcs-api"], body: "x", tag_agents: [chatAgent] }
    });

    expect(byId.status).toBe(404);
    expect(byId.error).toBe("no such agent");
    expect(byName.status).toBe(404);
    expect(byItsOwner.status).toBe(404);
    expect(await prisma.message.count()).toBe(0);
  });

  it.each([
    ["a tag that is not a string", [42]],
    ["a blank tag", ["  "]],
    ["a field that is not an array", "bob-ccd"]
  ])("should refuse %s", async (_label, tag_agents) => {
    expect((await refusal({ tag_agents })).status).toBe(400);
    await nothingWritten();
  });
});
