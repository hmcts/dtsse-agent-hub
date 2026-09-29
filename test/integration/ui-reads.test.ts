import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { saveChannel } from "../../src/channels/store.ts";
import { createDirect, createPost } from "../../src/messages/store.ts";
import type { Identity } from "../../src/users/identity.ts";
import { agentPage, channel, overview, sidebarData } from "../../src/web/data.ts";
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

    const owner = await agentPage(viewer(ALICE), alicesAgent);
    const grantee = await agentPage(viewer(BOB), alicesAgent);

    expect(owner?.thread.map((message) => [message.body, message.delivery])).toEqual([
      ["to it", "queued"],
      ["to carol's agent", "queued"],
      ["reply to alice", null]
    ]);
    expect(grantee?.thread.map((message) => message.body)).toEqual(["to it", "reply to alice"]);
    expect(grantee?.posts.map((message) => message.body)).toEqual(["a post"]);
  });
});

describe("overview", () => {
  it("should show activity on the viewer's channel topics, or everywhere when they have none", async () => {
    await createPost(prisma, { author: { oid: CAROL.oid, agentId: null }, topics: ["a"], title: null, body: "on a", inReplyTo: null });
    await createPost(prisma, { author: { oid: CAROL.oid, agentId: null }, topics: ["b"], title: null, body: "on b", inReplyTo: null });

    expect((await overview(viewer(BOB))).activity.messages.map((message) => message.body)).toEqual(["on a", "on b"]);
    await saveChannel(prisma, BOB.oid, { name: "a only", topics: ["a"], match: "any", shared: false });
    const withChannel = await overview(viewer(BOB));
    expect(withChannel.topics).toEqual(["a"]);
    expect(withChannel.activity.messages.map((message) => message.body)).toEqual(["on a"]);
  });
});
