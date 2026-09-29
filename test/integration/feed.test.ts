import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as cursor } from "../../src/app/api/agent/[agentId]/cursor/route.ts";
import { GET as feed } from "../../src/app/api/agent/[agentId]/feed/route.ts";
import { POST as posts } from "../../src/app/api/agent/[agentId]/posts/route.ts";
import { PUT as subscribe, GET as subscriptions, DELETE as unsubscribe } from "../../src/app/api/agent/[agentId]/subscriptions/route.ts";
import { GET as topicMessages } from "../../src/app/api/agent/topics/[slug]/messages/route.ts";
import { GET as topics } from "../../src/app/api/agent/topics/route.ts";
import { channelFeed } from "../../src/messages/feed.ts";
import { insertAgent, type Person, person, prisma, resetDatabase } from "./database.ts";
import { call, jsonOf } from "./routes.ts";

const ALICE = person("alice");
const BOB = person("bob");
let reader: string;
let writer: string;

async function post(as: Person, agentId: string, topicList: string[], body = "text", extra: Record<string, unknown> = {}): Promise<string> {
  const response = await call(posts, {
    as,
    path: `/api/agent/${agentId}/posts`,
    method: "POST",
    params: { agentId },
    body: { topics: topicList, title: "t", body, ...extra }
  });
  expect(response.status).toBe(201);
  return (await jsonOf(response)).message.id;
}

async function readFeed(since?: string, limit?: number) {
  const query = new URLSearchParams({ ...(since === undefined ? {} : { since }), ...(limit === undefined ? {} : { limit: String(limit) }) });
  const response = await call(feed, { as: ALICE, path: `/api/agent/${reader}/feed?${query}`, params: { agentId: reader } });
  expect(response.status).toBe(200);
  return await jsonOf<{ messages: { id: string; topics: string[] }[]; cursor: string }>(response);
}

beforeEach(async () => {
  await resetDatabase();
  reader = await insertAgent(ALICE, "alice-reader");
  writer = await insertAgent(BOB, "bob-writer");
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("posts", () => {
  it("should normalise topics, create them on first use and stamp their last activity", async () => {
    const response = await call(posts, {
      as: BOB,
      path: `/api/agent/${writer}/posts`,
      method: "POST",
      params: { agentId: writer },
      body: { topics: ["PCS-API", " database ", "pcs-api"], title: "Flyway", body: "V022 is now V027" }
    });

    expect(response.status).toBe(201);
    const { message } = await jsonOf(response);
    expect(message).toMatchObject({
      kind: "post",
      title: "Flyway",
      topics: ["database", "pcs-api"],
      target_agent_id: null,
      author: { type: "agent", agent_id: writer, agent_name: "bob-writer", owner_name: BOB.name, owner_email: BOB.email }
    });
    const stamped = await prisma.topic.findMany({ orderBy: { slug: "asc" } });
    expect(stamped.map((topic) => topic.slug)).toEqual(["database", "pcs-api"]);
    expect(stamped.every((topic) => topic.lastMessageAt !== null)).toBe(true);
  });

  it.each([
    ["no topics", { topics: [] }],
    ["six topics", { topics: ["a", "b", "c", "d", "e", "f"] }],
    ["a topic that is not a slug", { topics: ["has space"] }],
    ["an empty body", { topics: ["a"], body: " " }],
    ["a reply to a post that does not exist", { topics: ["a"], in_reply_to: "999" }]
  ])("should refuse a post with %s", async (_label, body) => {
    const response = await call(posts, {
      as: BOB,
      path: `/api/agent/${writer}/posts`,
      method: "POST",
      params: { agentId: writer },
      body: { body: "b", ...body }
    });

    expect(response.status).toBe(400);
    expect(await prisma.message.count()).toBe(0);
  });

  it("should thread a reply to an existing post", async () => {
    const parent = await post(BOB, writer, ["a"]);

    const reply = await post(ALICE, reader, ["a"], "agreed", { in_reply_to: parent });

    expect((await prisma.message.findUniqueOrThrow({ where: { id: BigInt(reply) } })).inReplyTo).toBe(BigInt(parent));
  });
});

describe("subscriptions", () => {
  it("should add to and remove from the set, creating unknown topics", async () => {
    const params = { agentId: reader };
    const path = `/api/agent/${reader}/subscriptions`;

    expect(await jsonOf(await call(subscribe, { as: ALICE, path, params, method: "PUT", body: { topics: ["Zeta", "alpha"] } }))).toEqual({
      topics: ["alpha", "zeta"]
    });
    expect(await jsonOf(await call(subscribe, { as: ALICE, path, params, method: "PUT", body: { topics: ["beta"] } }))).toEqual({
      topics: ["alpha", "beta", "zeta"]
    });
    expect(await jsonOf(await call(unsubscribe, { as: ALICE, path, params, method: "DELETE", body: { topics: ["zeta", "never"] } }))).toEqual({
      topics: ["alpha", "beta"]
    });
    expect(await jsonOf(await call(subscriptions, { as: ALICE, path, params }))).toEqual({ topics: ["alpha", "beta"] });
  });

  it("should refuse a subscription to something that is not a slug", async () => {
    const response = await call(subscribe, {
      as: ALICE,
      path: `/api/agent/${reader}/subscriptions`,
      params: { agentId: reader },
      method: "PUT",
      body: { topics: ["no/slash"] }
    });

    expect(response.status).toBe(400);
  });
});

describe("GET /api/agent/{agent_id}/feed", () => {
  beforeEach(async () => {
    await call(subscribe, { as: ALICE, path: "", params: { agentId: reader }, method: "PUT", body: { topics: ["pcs-api", "database"] } });
  });

  it("should return posts on any subscribed topic after the cursor, oldest first, once each and never the agent's own", async () => {
    const first = await post(BOB, writer, ["pcs-api"]);
    await post(BOB, writer, ["unrelated"]);
    const both = await post(BOB, writer, ["pcs-api", "database"]);
    await post(ALICE, reader, ["pcs-api"], "my own");
    const third = await post(BOB, writer, ["database", "other"]);

    const page = await readFeed("0");

    expect(page.messages.map((message) => message.id)).toEqual([first, both, third]);
    expect(page.cursor).toBe(third);
  });

  it("should page with since and limit, and hand back since as the cursor when nothing is new", async () => {
    const ids = [await post(BOB, writer, ["pcs-api"]), await post(BOB, writer, ["pcs-api"]), await post(BOB, writer, ["pcs-api"])];

    const first = await readFeed("0", 2);
    const second = await readFeed(first.cursor, 2);
    const empty = await readFeed(second.cursor, 2);

    expect(first.messages.map((message) => message.id)).toEqual(ids.slice(0, 2));
    expect(second.messages.map((message) => message.id)).toEqual(ids.slice(2));
    expect(empty).toEqual({ messages: [], cursor: ids[2] });
  });

  it("should read from the stored cursor when no since is given", async () => {
    const seen = await post(BOB, writer, ["pcs-api"]);
    const unseen = await post(BOB, writer, ["pcs-api"]);

    const stored = await call(cursor, { as: ALICE, path: "", params: { agentId: reader }, method: "POST", body: { cursor: seen } });
    const page = await readFeed();

    expect(stored.status).toBe(204);
    expect(page.messages.map((message) => message.id)).toEqual([unseen]);
  });

  it("should refuse a limit above 100", async () => {
    const response = await call(feed, { as: ALICE, path: `/api/agent/${reader}/feed?limit=101`, params: { agentId: reader } });

    expect(response.status).toBe(400);
  });
});

describe("topics", () => {
  it("should list topics by prefix, most recently active first, with their message counts", async () => {
    await post(BOB, writer, ["pcs-api"]);
    await post(BOB, writer, ["pcs-frontend", "pcs-api"]);
    await post(BOB, writer, ["ccd"]);
    await call(subscribe, { as: ALICE, path: "", params: { agentId: reader }, method: "PUT", body: { topics: ["pcs-quiet"] } });

    const response = await call(topics, { as: ALICE, path: "/api/agent/topics?prefix=PCS" });

    const { topics: listed } = await jsonOf(response);
    expect(listed.map((topic: { slug: string; message_count: number }) => [topic.slug, topic.message_count])).toEqual([
      ["pcs-api", 2],
      ["pcs-frontend", 1],
      ["pcs-quiet", 0]
    ]);
    expect(listed[2].last_message_at).toBeNull();
  });

  it("should treat LIKE wildcards in the prefix literally", async () => {
    await post(BOB, writer, ["pcs-api"]);

    expect((await jsonOf(await call(topics, { as: ALICE, path: "/api/agent/topics?prefix=%25" }))).topics).toEqual([]);
  });

  it("should page a topic's posts whether or not the caller subscribes", async () => {
    const ids = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push(await post(BOB, writer, ["board"]));
    }
    await post(BOB, writer, ["elsewhere"]);
    const read = async (query: string) =>
      (await jsonOf(await call(topicMessages, { as: ALICE, path: `/api/agent/topics/board/messages?${query}`, params: { slug: "board" } }))).messages.map(
        (message: { id: string }) => message.id
      );

    expect(await read("limit=2")).toEqual(ids.slice(3));
    expect(await read(`before=${ids[3]}&limit=2`)).toEqual([ids[2], ids[1]]);
    expect(await read(`since=${ids[1]}&limit=2`)).toEqual([ids[2], ids[3]]);
    expect(await read("")).toEqual(ids);
  });

  it("should refuse before and since together, and answer an unknown topic with an empty list", async () => {
    const both = await call(topicMessages, { as: ALICE, path: "/api/agent/topics/board/messages?before=5&since=1", params: { slug: "board" } });
    const unknown = await call(topicMessages, { as: ALICE, path: "/api/agent/topics/nothing/messages", params: { slug: "nothing" } });

    expect(both.status).toBe(400);
    expect(await jsonOf(unknown)).toEqual({ messages: [] });
  });
});

describe("channelFeed", () => {
  it("should match any or all of a topic set, newest page returned oldest first, with keyset paging", async () => {
    const onlyA = await post(BOB, writer, ["a"]);
    const both = await post(BOB, writer, ["a", "b"]);
    const onlyB = await post(BOB, writer, ["b"]);
    const bothAgain = await post(BOB, writer, ["b", "a", "c"]);

    const ids = async (query: Parameters<typeof channelFeed>[1]) => (await channelFeed(prisma, query)).map((message) => message.id);

    expect(await ids({ topics: ["a", "b"], match: "any", limit: 10 })).toEqual([onlyA, both, onlyB, bothAgain]);
    expect(await ids({ topics: ["a", "b"], match: "all", limit: 10 })).toEqual([both, bothAgain]);
    expect(await ids({ topics: ["a", "b"], match: "any", limit: 2 })).toEqual([onlyB, bothAgain]);
    expect(await ids({ topics: ["a", "b"], match: "any", before: BigInt(onlyB), limit: 10 })).toEqual([onlyA, both]);
    expect(await ids({ topics: [], match: "any", limit: 10 })).toEqual([]);
  });
});
