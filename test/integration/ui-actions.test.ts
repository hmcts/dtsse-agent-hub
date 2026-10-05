import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { directAsAgent } from "../../src/messages/send.ts";
import { devIdentity } from "../../src/viewer/identity.ts";
import { insertAgent, insertUser, type Person, prisma, resetDatabase } from "./database.ts";

vi.mock("next/headers", async () => {
  const { jar } = await import("./web-session.ts");
  return { cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined) }) };
});
vi.mock("next/cache", async () => {
  const { revalidated } = await import("./web-session.ts");
  return { revalidatePath: (path: string) => void revalidated.push(path) };
});

const { actAs, revalidated } = await import("./web-session.ts");
const { postToTopics } = await import("../../src/app/_actions/posts.ts");
const { sendDirect } = await import("../../src/app/_actions/direct.ts");
const { grantAccess, revokeAccess } = await import("../../src/app/_actions/grants.ts");
const { createChannel, removeChannel } = await import("../../src/app/_actions/channels.ts");

function persona(name: string): Person {
  const identity = devIdentity(name);
  return { oid: identity.oid, name: identity.name, email: identity.email! };
}

const ALICE = persona("alice");
const BOB = persona("bob");

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    data.set(key, value);
  }
  return data;
}

beforeEach(async () => {
  await resetDatabase();
  revalidated.length = 0;
  actAs("alice");
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("postToTopics", () => {
  it("should post as the signed-in person with no author agent when the topics are valid", async () => {
    const result = await postToTopics({ topics: ["PCS-API", "database"], title: " A title ", body: "hello", inReplyTo: null });

    expect(result).toMatchObject({
      ok: true,
      message: { topics: ["database", "pcs-api"], title: "A title", author: { type: "user", agent_id: null, owner_name: ALICE.name } }
    });
    const row = await prisma.message.findFirstOrThrow({ select: { authorOid: true, authorAgentId: true } });
    expect(row).toEqual({ authorOid: ALICE.oid, authorAgentId: null });
  });

  it("should record the session's person, not anyone named in the input, as the author", async () => {
    await postToTopics({ topics: ["a"], body: "hi", authorOid: BOB.oid } as never);

    expect((await prisma.message.findFirstOrThrow()).authorOid).toBe(ALICE.oid);
  });

  it("should reply to a post when in_reply_to names one", async () => {
    const parent = await postToTopics({ topics: ["a"], body: "parent" });
    const reply = await postToTopics({ topics: ["a"], body: "reply", inReplyTo: parent.ok ? parent.message.id : "" });

    expect(reply).toMatchObject({ ok: true, message: { in_reply_to: parent.ok ? parent.message.id : null } });
  });

  it.each([
    ["no topics", { topics: [], body: "x" }, "between 1 and 10"],
    ["eleven topics", { topics: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"], body: "x" }, "between 1 and 10"],
    ["a bad slug", { topics: ["no spaces"], body: "x" }, "is not a topic"],
    ["an empty body", { topics: ["a"], body: "  " }, "write something"],
    ["a reply to nothing", { topics: ["a"], body: "x", inReplyTo: "999" }, "in_reply_to"],
    ["a malformed reply id", { topics: ["a"], body: "x", inReplyTo: "abc" }, "not a post"],
    ["a reply id past the bigint range", { topics: ["a"], body: "x", inReplyTo: "9223372036854775808" }, "not a post"],
    ["a title that is too long", { topics: ["a"], body: "x", title: "t".repeat(301) }, "at most 300"],
    ["a body that is too long", { topics: ["a"], body: "b".repeat(32_001) }, "at most 32000"]
  ])("should refuse %s and write nothing", async (_label, input, error) => {
    const result = await postToTopics(input);

    expect(result.ok ? undefined : result.error).toContain(error);
    expect(await prisma.message.count()).toBe(0);
  });
});

describe("sendDirect", () => {
  it("should queue a delivery to the agent and notify, the same as the agent API path, when the sender owns it", async () => {
    const agent = await insertAgent(ALICE, "alices-agent");

    const result = await sendDirect({ agentId: agent, body: "wake up" });

    expect(result).toMatchObject({ ok: true, message: { kind: "direct", target_agent_id: agent, delivery: "queued", author: { type: "user" } } });
    expect(await prisma.delivery.findMany({ select: { agentId: true, state: true } })).toEqual([{ agentId: agent, state: "queued" }]);
  });

  it("should let a write grantee message the agent", async () => {
    const agent = await insertAgent(BOB, "bobs-agent");
    await insertUser(ALICE);
    await prisma.agentGrant.create({ data: { ownerOid: BOB.oid, granteeOid: ALICE.oid, level: "write" } });

    expect((await sendDirect({ agentId: agent, body: "hi" })).ok).toBe(true);
  });

  it("should refuse a read grantee and write nothing", async () => {
    const agent = await insertAgent(BOB, "bobs-agent");
    await insertUser(ALICE);
    await prisma.agentGrant.create({ data: { ownerOid: BOB.oid, granteeOid: ALICE.oid, level: "read" } });

    expect(await sendDirect({ agentId: agent, body: "hi" })).toEqual({ ok: false, error: "you have read access to this agent, not write access" });
    expect(await prisma.message.count()).toBe(0);
  });

  it.each([
    ["an agent the sender cannot see", async () => await insertAgent(BOB, "bobs-agent")],
    ["an id that is not an agent", async () => "00000000-0000-0000-0000-000000000000"],
    ["something that is not an id", async () => "bobs-agent"]
  ])("should report %s as missing", async (_label, target) => {
    expect(await sendDirect({ agentId: await target(), body: "hi" })).toEqual({ ok: false, error: "no such agent" });
  });

  it("should refuse an empty or oversized message", async () => {
    const agent = await insertAgent(ALICE, "alices-agent");

    expect((await sendDirect({ agentId: agent, body: " " })).ok).toBe(false);
    expect((await sendDirect({ agentId: agent, body: "x".repeat(32_001) })).ok).toBe(false);
  });

  it("should show an agent's reply to the person in the thread they sent from", async () => {
    const agent = await insertAgent(ALICE, "alices-agent");
    const sent = await sendDirect({ agentId: agent, body: "question" });
    const message = sent.ok ? sent.message : undefined;

    const reply = await directAsAgent(prisma, { id: agent, ownerOid: ALICE.oid }, { replyTo: BigInt(message!.id), body: "answer" });

    expect(reply).toMatchObject({ target_agent_id: null, in_reply_to: message!.id });
  });
});

describe("grantAccess and revokeAccess", () => {
  it("should grant a known person access to the signed-in person's agents by email, then revoke it", async () => {
    await insertUser(ALICE);
    await insertUser(BOB);

    const granted = await grantAccess(form({ email: " BOB@dev.invalid ", level: "write" }));

    expect(granted).toEqual({ ok: true, confirmation: `${BOB.name} now has write access to your agents` });
    expect(await prisma.agentGrant.findMany({ select: { ownerOid: true, granteeOid: true, level: true } })).toEqual([
      { ownerOid: ALICE.oid, granteeOid: BOB.oid, level: "write" }
    ]);
    expect(revalidated).toContain("/access");

    expect(await revokeAccess(form({ grantee: BOB.oid }))).toEqual({ ok: true });
    expect(await prisma.agentGrant.count()).toBe(0);
  });

  it("should change the level when the grant exists, defaulting to read", async () => {
    await insertUser(BOB);
    await grantAccess(form({ email: BOB.email, level: "write" }));

    await grantAccess(form({ email: BOB.email, level: "admin" }));

    expect((await prisma.agentGrant.findFirstOrThrow()).level).toBe("read");
  });

  it("should refuse someone the hub has never seen", async () => {
    expect(await grantAccess(form({ email: "nobody@dev.invalid", level: "read" }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("has used the hub yet")
    });
  });

  it("should refuse an empty address", async () => {
    expect((await grantAccess(form({ email: "", level: "read" }))).ok).toBe(false);
  });

  it("should refuse an address shared by two people", async () => {
    await insertUser({ oid: "one", name: "One", email: "shared@example.com" });
    await insertUser({ oid: "two", name: "Two", email: "SHARED@example.com" });

    expect(await grantAccess(form({ email: "shared@example.com", level: "read" }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("more than one")
    });
  });

  it("should refuse a grant to yourself", async () => {
    await insertUser(ALICE);

    expect(await grantAccess(form({ email: ALICE.email, level: "read" }))).toEqual({ ok: false, error: "you cannot grant yourself access" });
  });

  it("should only ever revoke the signed-in person's own grants", async () => {
    await insertUser(ALICE);
    await insertUser(BOB);
    await prisma.agentGrant.create({ data: { ownerOid: BOB.oid, granteeOid: ALICE.oid, level: "write" } });

    await revokeAccess(form({ grantee: ALICE.oid }));

    expect(await prisma.agentGrant.count()).toBe(1);
    expect((await revokeAccess(form({}))).ok).toBe(false);
  });
});

describe("createChannel and removeChannel", () => {
  it("should save a channel owned by the signed-in person when it is valid", async () => {
    const result = await createChannel({ name: " PCS ", topics: ["PCS-API", "database"], match: "all", shared: true });

    expect(result.ok).toBe(true);
    expect(await prisma.channel.findMany({ select: { ownerOid: true, name: true, topics: true, match: true, shared: true } })).toEqual([
      { ownerOid: ALICE.oid, name: "PCS", topics: ["pcs-api", "database"], match: "all", shared: true }
    ]);
    expect(revalidated).toContain("/");
  });

  it("should refuse an invalid channel and save nothing", async () => {
    const result = await createChannel({ name: "", topics: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"], match: "any", shared: false });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("give the channel a name; a channel has between 1 and 10 topics") });
    expect(await prisma.channel.count()).toBe(0);
  });

  it("should delete the owner's channel and leave anyone else's alone", async () => {
    const mine = await createChannel({ name: "mine", topics: ["a"], match: "any", shared: true });
    actAs("bob");

    expect(await removeChannel(form({ id: mine.ok ? mine.id : "" }))).toEqual({ ok: false, error: "that is not one of your channels" });
    actAs("alice");
    expect(await removeChannel(form({ id: mine.ok ? mine.id : "" }))).toEqual({ ok: true });
    expect(await prisma.channel.count()).toBe(0);
  });
});
