import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { saveChannel } from "../../src/channels/store.ts";
import { createDirect, createPost } from "../../src/messages/store.ts";
import { byCodePoint } from "../../src/topics/slug.ts";
import type { Identity } from "../../src/users/identity.ts";
import { agentActivity, agentPage, channel, messagePage, overview, sidebarData, topics as topicList } from "../../src/web/data.ts";
import { insertAgent, insertUser, type Person, prisma, resetDatabase } from "./database.ts";

const ALICE = { oid: "oid-alice", name: "Alice", email: "alice@example.com" };
const BOB = { oid: "oid-bob", name: "Bob", email: "bob@example.com" };
const CAROL = { oid: "oid-carol", name: "Carol", email: "carol@example.com" };

const viewer = (who: Person): Identity => ({ ...who, tid: "dev" });

let alicesAgent: string;
let carolsAgent: string;

beforeEach(async () => {
  await resetDatabase();
  alicesAgent = await insertAgent(ALICE, "alices-agent", { status: "offline" });
  carolsAgent = await insertAgent(CAROL, "carols-agent");
  await insertUser(BOB);
  await prisma.agentGrant.create({ data: { ownerOid: ALICE.oid, granteeOid: BOB.oid, level: "read" } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("sidebarData", () => {
  it("should list only own agents and those granted, with own and shared channels", async () => {
    await saveChannel(prisma, ALICE.oid, { name: "shared one", topics: ["a"], match: "any", shared: true });
    await saveChannel(prisma, ALICE.oid, { name: "private one", topics: ["a"], match: "any", shared: false });
    await saveChannel(prisma, BOB.oid, { name: "bobs", topics: ["b"], match: "all", shared: false });

    const bob = await sidebarData(viewer(BOB));

    expect(bob.mine).toEqual([]);
    expect(bob.shared.map((agent) => agent.name)).toEqual(["alices-agent"]);
    expect(bob.channels.mine.map((entry) => entry.name)).toEqual(["bobs"]);
    expect(bob.channels.shared.map((entry) => entry.name)).toEqual(["shared one"]);
    expect((await sidebarData(viewer(ALICE))).mine.map((agent) => agent.id)).toEqual([alicesAgent]);
  });

  it("should list the topics with the most posts this week first, and leave out those quiet all week", async () => {
    const post = (topics: string[]) => createPost(prisma, { author: { oid: CAROL.oid, agentId: null }, topics, title: null, body: "x", inReplyTo: null });
    await post(["busy", "quiet"]);
    await post(["busy"]);
    await post(["busy"]);
    await post(["middling"]);
    await post(["middling"]);
    const old = await post(["stale"]);
    await prisma.message.update({ where: { id: BigInt(old.id) }, data: { createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) } });

    const { topics } = await sidebarData(viewer(BOB));

    expect(topics.map((topic) => [topic.slug, topic.message_count])).toEqual([
      ["busy", 3],
      ["middling", 2],
      ["quiet", 1]
    ]);
  });

  it("should leave out the e2e suite's topics when they are the busiest", async () => {
    const post = (topics: string[]) => createPost(prisma, { author: { oid: CAROL.oid, agentId: null }, topics, title: null, body: "x", inReplyTo: null });
    await post(["e2e-abc12", "real"]);
    await post(["e2e-abc12"]);

    const { topics } = await sidebarData(viewer(BOB));

    expect(topics.map((topic) => topic.slug)).toEqual(["real"]);
  });
});

describe("topics", () => {
  beforeEach(async () => {
    await createPost(prisma, { author: { oid: CAROL.oid, agentId: null }, topics: ["e2e-abc12", "e2e", "real"], title: null, body: "x", inReplyTo: null });
  });

  it("should leave out the e2e suite's topics when the search is not for them", async () => {
    expect((await topicList("")).map((topic) => topic.slug).sort(byCodePoint)).toEqual(["e2e", "real"]);
  });

  it("should list the e2e suite's topics when the search is for them", async () => {
    expect((await topicList("e2e")).map((topic) => topic.slug).sort(byCodePoint)).toEqual(["e2e", "e2e-abc12"]);
  });
});

describe("channel", () => {
  it("should open a shared channel for anyone and a private one for its owner alone", async () => {
    const hidden = await saveChannel(prisma, ALICE.oid, { name: "private", topics: ["a"], match: "any", shared: false });

    expect(await channel(viewer(BOB), hidden)).toBeUndefined();
    expect((await channel(viewer(ALICE), hidden))?.name).toBe("private");
    expect(await channel(viewer(ALICE), "not-an-id")).toBeUndefined();
  });
});

describe("agentPage", () => {
  it("should give the owner, a grantee and a stranger what each may see of an agent", async () => {
    expect((await agentPage(viewer(ALICE), alicesAgent))?.access).toBe("owner");
    expect((await agentPage(viewer(BOB), alicesAgent))?.access).toBe("read");
    expect(await agentPage(viewer(BOB), carolsAgent)).toBeUndefined();
    expect(await agentPage(viewer(BOB), "00000000-0000-0000-0000-000000000000")).toBeUndefined();
    expect(await agentPage(viewer(BOB), "nope")).toBeUndefined();
  });

  it("should show the thread both ways with delivery state, leaving out what the viewer may not read", async () => {
    const incoming = await createDirect(prisma, { author: { oid: ALICE.oid, agentId: null }, targetAgentId: alicesAgent, inReplyTo: null, body: "to it" });
    await createDirect(prisma, { author: { oid: ALICE.oid, agentId: alicesAgent }, targetAgentId: carolsAgent, inReplyTo: null, body: "to carol's agent" });
    await createDirect(prisma, {
      author: { oid: ALICE.oid, agentId: alicesAgent },
      targetAgentId: null,
      inReplyTo: BigInt(incoming.id),
      body: "reply to alice"
    });
    await createPost(prisma, { author: { oid: ALICE.oid, agentId: alicesAgent }, topics: ["a"], title: null, body: "a post", inReplyTo: null });

    const owner = await agentActivity(viewer(ALICE), (await agentPage(viewer(ALICE), alicesAgent))!);
    const grantee = await agentActivity(viewer(BOB), (await agentPage(viewer(BOB), alicesAgent))!);

    expect(owner.thread.map((message) => [message.body, message.delivery])).toEqual([
      ["to it", "queued"],
      ["to carol's agent", "queued"],
      ["reply to alice", null]
    ]);
    expect(grantee.thread.map((message) => message.body)).toEqual(["to it", "reply to alice"]);
    expect(grantee.posts.map((message) => message.body)).toEqual(["a post"]);
  });
});

describe("overview", () => {
  it("should show activity on the viewer's channel topics, or everywhere when they have none", async () => {
    await createPost(prisma, { author: { oid: CAROL.oid, agentId: null }, topics: ["a"], title: null, body: "on a", inReplyTo: null });
    await createPost(prisma, { author: { oid: CAROL.oid, agentId: null }, topics: ["b"], title: null, body: "on b", inReplyTo: null });

    const everywhere = await overview(viewer(BOB));
    expect(everywhere.watched).toBe("everything");
    expect(everywhere.activity.messages.map((message) => message.body)).toEqual(["on a", "on b"]);
    await saveChannel(prisma, BOB.oid, { name: "a only", topics: ["a"], match: "any", shared: false });
    const withChannel = await overview(viewer(BOB));
    expect(withChannel.topics).toEqual(["a"]);
    expect(withChannel.watched).toEqual(["a"]);
    expect(withChannel.activity.messages.map((message) => message.body)).toEqual(["on a"]);
  });

  it("should offer older posts on every topic when the viewer has no channels and there are more than a page", async () => {
    for (let index = 1; index <= 31; index += 1) {
      await createPost(prisma, { author: { oid: CAROL.oid, agentId: null }, topics: ["a"], title: null, body: `post ${index}`, inReplyTo: null });
    }

    const { activity } = await overview(viewer(BOB));

    expect(activity.messages).toHaveLength(30);
    expect(activity.messages[0]!.body).toBe("post 2");
    expect(activity.olderBefore).toBe(activity.messages[0]!.id);
  });
});

describe("messagePage", () => {
  const post = (author: Person, body: string, inReplyTo: string | null = null) =>
    createPost(prisma, {
      author: { oid: author.oid, agentId: null },
      topics: ["a"],
      title: null,
      body,
      inReplyTo: inReplyTo === null ? null : BigInt(inReplyTo)
    });

  it("should show a post with its parent and only the replies the viewer may read", async () => {
    const parent = await post(ALICE, "the question");
    const root = await post(CAROL, "an answer", parent.id);
    await post(ALICE, "a public reply", root.id);
    await createDirect(prisma, { author: { oid: CAROL.oid, agentId: null }, targetAgentId: carolsAgent, inReplyTo: BigInt(root.id), body: "a private reply" });
    await post(ALICE, "unrelated");

    const bob = await messagePage(viewer(BOB), root.id);
    const carol = await messagePage(viewer(CAROL), root.id);

    expect(bob?.message.body).toBe("an answer");
    expect(bob?.parent?.body).toBe("the question");
    expect(bob?.replies.map((reply) => reply.body)).toEqual(["a public reply"]);
    expect(carol?.replies.map((reply) => [reply.body, reply.delivery])).toEqual([
      ["a public reply", null],
      ["a private reply", "queued"]
    ]);
    expect((await messagePage(viewer(BOB), parent.id))?.parent).toBeNull();
  });

  it("should show a direct message to those who may read it and to nobody else", async () => {
    const direct = await createDirect(prisma, { author: { oid: ALICE.oid, agentId: null }, targetAgentId: alicesAgent, inReplyTo: null, body: "private" });
    const hidden = await createDirect(prisma, { author: { oid: CAROL.oid, agentId: null }, targetAgentId: carolsAgent, inReplyTo: null, body: "carol's" });

    expect((await messagePage(viewer(ALICE), direct.id))?.message.body).toBe("private");
    expect((await messagePage(viewer(BOB), direct.id))?.message.body).toBe("private");
    expect(await messagePage(viewer(BOB), hidden.id)).toBeUndefined();
    expect(await messagePage(viewer(ALICE), hidden.id)).toBeUndefined();
    expect((await messagePage(viewer(CAROL), hidden.id))?.message.kind).toBe("direct");
  });

  it("should leave out a parent the viewer may not read when a readable post replies to it", async () => {
    const hidden = await createDirect(prisma, { author: { oid: CAROL.oid, agentId: null }, targetAgentId: carolsAgent, inReplyTo: null, body: "carol's" });
    const reply = await post(CAROL, "public follow-up", hidden.id);

    const bob = await messagePage(viewer(BOB), reply.id);

    expect(bob?.message.in_reply_to).toBe(hidden.id);
    expect(bob?.parent).toBeNull();
    expect((await messagePage(viewer(CAROL), reply.id))?.parent?.body).toBe("carol's");
  });

  it("should answer not-found when the id is malformed, out of range or has no message", async () => {
    for (const id of ["abc", "0", "007", "-1", "9223372036854775808", "999999"]) {
      expect(await messagePage(viewer(ALICE), id)).toBeUndefined();
    }
  });
});
