import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { forkRecipients } from "../../src/assistant/fork-store.ts";
import { FORK_CONTEXT_FILE_NAME } from "../../src/assistant/forks.ts";
import { ensureAssistant, findAssistant, writeArtefact } from "../../src/assistant/store.ts";
import { frameAttachments } from "../../src/assistant/upload-store.ts";
import { sweepUploads } from "../../src/assistant/upload-sweep.ts";
import { realtime } from "../../src/realtime/process.ts";
import { devIdentity } from "../../src/viewer/identity.ts";
import { connectForChat, type Person, prisma, resetDatabase } from "./database.ts";

/**
 * Forking an HMCTS Assistant conversation: Alice offers her chat to Bob, who takes his own copy into his own
 * Assistant and carries on there. Carol holds a plain read share of the chat, which makes her the right stranger to
 * the fork: as close to it as anyone can be without being offered it.
 */

vi.mock("next/headers", async () => {
  const { jar } = await import("./web-session.ts");
  return { cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined) }) };
});
vi.mock("next/cache", async () => {
  const { revalidated } = await import("./web-session.ts");
  return { revalidatePath: (path: string) => void revalidated.push(path) };
});

const { actAs } = await import("./web-session.ts");
const assistantActions = await import("../../src/app/_actions/assistant.ts");
const shareActions = await import("../../src/app/_actions/shares.ts");
const forkActions = await import("../../src/app/_actions/forks.ts");
const { assistantConversation, chatForks, sharedChat, sharedChats } = await import("../../src/web/data.ts");

function persona(name: string): Person {
  const identity = devIdentity(name);
  return { oid: identity.oid, name: identity.name, email: identity.email! };
}

const ALICE = persona("alice");
const BOB = persona("bob");
const CAROL = persona("carol");

const viewerOf = (who: Person) => ({ ...who, tid: "dev", modelRoute: "own-licence" as const });

/** Alice's chat, with one question, one answer and a document. */
async function chat(): Promise<{ id: string; agentId: string }> {
  actAs("alice");
  await ensureAssistant(prisma, viewerOf(ALICE));
  const started = await assistantActions.startConversation({ product: "general", body: "What goes in a possession order?" });
  const id = (started as { ok: true; id: string }).id;
  const conversation = await prisma.assistantConversation.findUniqueOrThrow({ where: { id }, select: { agentId: true, virtualAgentId: true, ownerOid: true } });
  const agentId = conversation.agentId!;
  await prisma.message.create({
    data: { kind: "direct", authorOid: ALICE.oid, authorAgentId: agentId, targetAgentId: null, body: "The property, the date and the costs." }
  });
  await writeArtefact(
    prisma,
    { id, virtualAgentId: conversation.virtualAgentId, ownerOid: conversation.ownerOid },
    { title: "Draft order", markdown: "## Draft order\n\nThe property, the date and the costs.", baseVersion: 0, by: "agent" }
  );
  return { id, agentId };
}

/** Alice's chat, offered to Bob, with the actor left as Bob. */
async function offered(): Promise<{ id: string; agentId: string }> {
  const source = await chat();
  await forkActions.offerChatFork({ conversationId: source.id, recipientOid: BOB.oid });
  actAs("bob");
  return source;
}

async function take(id: string): Promise<string> {
  const result = await forkActions.forkChat({ conversationId: id });
  expect(result).toMatchObject({ ok: true });
  return (result as { ok: true; id: string }).id;
}

async function original(id: string) {
  return await prisma.assistantConversation.findUniqueOrThrow({
    where: { id },
    select: { ownerOid: true, title: true, artefactVersion: true, artefactMarkdown: true, lastActiveAt: true, agentId: true }
  });
}

beforeAll(async () => {
  await realtime().listener.ready();
});

beforeEach(async () => {
  vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "true");
  vi.stubEnv("SESSION_SECRET", "a-test-session-secret-long-enough-to-be-plausible");
  await resetDatabase();
  // Connected, so the chat gate lets each of them start a chat or take a copy; the gate has its own case below.
  await Promise.all([ALICE, BOB, CAROL].map(connectForChat));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await realtime().listener.stop();
  await prisma.$disconnect();
});

describe("offering a conversation to fork", () => {
  it("should list the person when the owner offers them the chat and take them off when the offer is withdrawn", async () => {
    const { id } = await chat();

    expect(await forkActions.offerChatFork({ conversationId: id, recipientOid: BOB.oid })).toMatchObject({ ok: true, people: [{ oid: BOB.oid }] });
    expect(await chatForks(viewerOf(ALICE), id)).toHaveLength(1);
    expect((await sharedChats(viewerOf(ALICE))).offered.map((link) => link.id)).toEqual([id]);

    expect(await forkActions.withdrawChatFork({ conversationId: id, recipientOid: BOB.oid })).toMatchObject({ ok: true, people: [] });
    expect(await forkRecipients(prisma, id)).toEqual([]);
  });

  it("should report the chat as missing when someone other than the owner offers it", async () => {
    const { id } = await chat();
    actAs("carol");

    expect(await forkActions.offerChatFork({ conversationId: id, recipientOid: CAROL.oid })).toEqual({ ok: false, error: "no such conversation" });
    expect(await chatForks(viewerOf(CAROL), id)).toBeUndefined();
    expect(await forkRecipients(prisma, id)).toEqual([]);
  });

  it("should refuse the offer when the person has never used the hub", async () => {
    const { id } = await chat();

    expect(await forkActions.offerChatFork({ conversationId: id, recipientOid: "dev-nobody" })).toEqual({
      ok: false,
      error: "that person has not used the hub yet, so cannot be offered it"
    });
  });

  it("should let the person offered read the chat and see the fork choice when they open its share page", async () => {
    const { id } = await offered();

    const view = await sharedChat(viewerOf(BOB), id);

    expect(view?.access).toBe("reader");
    expect(view?.fork).toEqual({ copyId: null });
    expect((await sharedChats(viewerOf(BOB))).forkable.map((link) => link.id)).toEqual([id]);
  });

  it("should offer a plain share reader no fork when they open the share page", async () => {
    const { id } = await chat();
    await shareActions.shareChat({ conversationId: id, recipientOid: CAROL.oid });

    expect((await sharedChat(viewerOf(CAROL), id))?.fork).toBeNull();
  });
});

describe("taking a copy", () => {
  it("should make the recipient their own copy, with the words, the document and where it came from, when they take it", async () => {
    const { id } = await offered();

    const copyId = await take(id);

    const copy = await prisma.assistantConversation.findUniqueOrThrow({ where: { id: copyId } });
    const bobs = await findAssistant(prisma, BOB.oid);
    expect(copy.ownerOid).toBe(BOB.oid);
    expect(copy.virtualAgentId).toBe(bobs?.id);
    expect(copy.agentId).not.toBeNull();
    expect(copy.forkedFromId).toBe(id);
    expect(copy.forkedFromOwnerName).toBe(ALICE.name);
    expect(copy.artefactMarkdown).toContain("Draft order");
    expect(copy.artefactVersion).toBe(1);
    expect(copy.artefactUpdatedBy).toBe("user");

    const view = await assistantConversation(viewerOf(BOB), copyId);
    expect(view?.forked?.fromOwnerName).toBe(ALICE.name);
    expect(view?.forked?.thread.map((item) => (item.type === "user" || item.type === "assistant" ? item.text : item.type))).toEqual([
      "What goes in a possession order?",
      "The property, the date and the costs."
    ]);
    // The copy has said nothing of its own yet.
    expect(view?.page.messages).toEqual([]);
  });

  it("should leave the original untouched and still the owner's alone when a copy is taken and spoken in", async () => {
    const { id, agentId } = await offered();
    const before = await original(id);
    const messagesBefore = await prisma.message.count({ where: { OR: [{ targetAgentId: agentId }, { authorAgentId: agentId }] } });

    const copyId = await take(id);
    expect(await assistantActions.sendAssistantMessage({ conversationId: copyId, body: "And the hearing?" })).toMatchObject({ ok: true });

    expect(await original(id)).toEqual(before);
    expect(await prisma.message.count({ where: { OR: [{ targetAgentId: agentId }, { authorAgentId: agentId }] } })).toBe(messagesBefore);
    expect(await assistantConversation(viewerOf(BOB), id)).toBeUndefined();
  });

  it("should refuse the recipient writing to the original when they send, rename or delete it", async () => {
    const { id } = await offered();
    await take(id);
    const before = await original(id);

    expect(await assistantActions.sendAssistantMessage({ conversationId: id, body: "Writing into Alice's chat" })).toMatchObject({ ok: false });
    expect(await assistantActions.renameConversation({ conversationId: id, title: "Bob's now" })).toMatchObject({ ok: false });
    expect(await assistantActions.deleteConversation({ conversationId: id })).toMatchObject({ ok: false });

    expect(await original(id)).toEqual(before);
  });

  it("should answer the copy already taken when the recipient takes it again", async () => {
    const { id } = await offered();

    const first = await take(id);
    const second = await take(id);

    expect(second).toBe(first);
    expect(await prisma.assistantConversation.count({ where: { ownerOid: BOB.oid, forkedFromId: id } })).toBe(1);
    expect((await sharedChat(viewerOf(BOB), id))?.fork).toEqual({ copyId: first });
  });

  it("should make one copy between them when two tabs take it at once", async () => {
    const { id } = await offered();

    const [one, two] = await Promise.all([take(id), take(id)]);

    expect(one).toBe(two);
    expect(await prisma.assistantConversation.count({ where: { ownerOid: BOB.oid, forkedFromId: id } })).toBe(1);
  });

  it.each([
    ["a reader of a plain share", "carol"],
    ["the owner", "alice"]
  ])("should refuse %s when they try to take a copy they were not offered", async (_label, who) => {
    const { id } = await offered();
    actAs("alice");
    await shareActions.shareChat({ conversationId: id, recipientOid: CAROL.oid });
    actAs(who);

    expect(await forkActions.forkChat({ conversationId: id })).toEqual({ ok: false, error: "no such conversation" });
    expect(await prisma.assistantConversation.count({ where: { forkedFromId: id } })).toBe(0);
  });

  it("should refuse a copy but leave one already taken when the offer is withdrawn", async () => {
    const { id } = await offered();
    const copyId = await take(id);
    await prisma.assistantConversation.delete({ where: { id: copyId } });
    const kept = await take(id);
    actAs("alice");

    await forkActions.withdrawChatFork({ conversationId: id, recipientOid: BOB.oid });
    actAs("bob");

    expect(await forkActions.forkChat({ conversationId: id })).toEqual({ ok: false, error: "no such conversation" });
    expect(await sharedChat(viewerOf(BOB), id)).toBeUndefined();
    expect(await assistantConversation(viewerOf(BOB), kept)).toBeDefined();
  });

  it("should keep the copy's provenance when the original is deleted", async () => {
    const { id } = await offered();
    const copyId = await take(id);
    actAs("alice");

    expect(await assistantActions.deleteConversation({ conversationId: id })).toMatchObject({ ok: true });

    const view = await assistantConversation(viewerOf(BOB), copyId);
    expect(view?.forked?.fromOwnerName).toBe(ALICE.name);
    expect(view?.forked?.thread).toHaveLength(2);
  });
});

describe("taking a copy before connecting", () => {
  it("should refuse the copy and make no conversation when the person offered it has not connected their accounts", async () => {
    const { id } = await offered();
    await prisma.credential.deleteMany({ where: { ownerOid: BOB.oid } });

    expect(await forkActions.forkChat({ conversationId: id })).toEqual({ ok: false, error: "connect your accounts before you start chatting" });
    expect(await prisma.assistantConversation.count({ where: { ownerOid: BOB.oid } })).toBe(0);
  });
});

describe("the copy's context for its session", () => {
  it("should attach the earlier turns to the first message sent in the copy and to no later one", async () => {
    const { id } = await offered();
    const copyId = await take(id);

    const first = await assistantActions.sendAssistantMessage({ conversationId: copyId, body: "And the hearing?" });
    const second = await assistantActions.sendAssistantMessage({ conversationId: copyId, body: "Thanks." });

    const firstId = BigInt((first as { ok: true; message: { id: string } }).message.id);
    const secondId = BigInt((second as { ok: true; message: { id: string } }).message.id);
    const attached = await frameAttachments(prisma, firstId);
    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatchObject({ name: "Earlier_conversation.md", media_type: "text/markdown" });
    expect(await frameAttachments(prisma, secondId)).toEqual([]);

    const upload = await prisma.assistantUpload.findUniqueOrThrow({ where: { id: attached[0]!.upload_id }, include: { parts: true } });
    expect(upload).toMatchObject({ fileName: FORK_CONTEXT_FILE_NAME, ownerOid: BOB.oid, conversationId: copyId, state: "stored" });
    const markdown = Buffer.concat(upload.parts.map((part) => Buffer.from(part.data))).toString("utf8");
    expect(markdown).toContain(`${ALICE.name} asked`);
    expect(markdown).toContain("What goes in a possession order?");
    expect(markdown).toContain("The property, the date and the costs.");
    expect(markdown).toContain("document was copied too");
  });

  it("should attach nothing when the conversation is not a copy", async () => {
    const { id } = await chat();

    const sent = await assistantActions.sendAssistantMessage({ conversationId: id, body: "And the hearing?" });

    expect(await frameAttachments(prisma, BigInt((sent as { ok: true; message: { id: string } }).message.id))).toEqual([]);
  });

  it("should keep an unspoken copy when the sweep removes empty chats", async () => {
    const { id } = await offered();
    const copyId = await take(id);
    // Old enough for the sweep's window, with no document, as a copy of a chat without one would be.
    await prisma.assistantConversation.update({
      where: { id: copyId },
      data: { createdAt: new Date(Date.now() - 48 * 3_600_000), artefactVersion: 0, artefactMarkdown: "" }
    });

    await sweepUploads(prisma, { retentionHours: 1 });

    expect(await prisma.assistantConversation.count({ where: { id: copyId } })).toBe(1);
  });
});
