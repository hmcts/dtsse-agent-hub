import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setGrant } from "../../src/access/load.ts";
import { GET as agentsRoster } from "../../src/app/api/agent/agents/route.ts";
import { GET as people } from "../../src/app/api/ui/people/route.ts";
import { GET as stream } from "../../src/app/api/ui/stream/route.ts";
import { shareRecipients } from "../../src/assistant/shares.ts";
import { ensureAssistant, readArtefact, writeArtefact } from "../../src/assistant/store.ts";
import { conversationMatches } from "../../src/assistant/views.ts";
import { realtime } from "../../src/realtime/process.ts";
import { devIdentity } from "../../src/viewer/identity.ts";
import { insertUser, type Person, prisma, resetDatabase } from "./database.ts";
import { call, jsonOf } from "./routes.ts";

/**
 * Sharing an HMCTS Assistant conversation, read-only, with people the owner names.
 *
 * Alice owns the chat, Bob is named in a share of it, Carol is not. Carol holds a write grant over every agent
 * Alice has, which is what makes her the right stranger: she is as close to the chat as the hub's older access model
 * can put anyone, and still sees nothing of it.
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
const { assistantConversation, chatShares, sharedChat, sharedChats } = await import("../../src/web/data.ts");

function persona(name: string): Person {
  const identity = devIdentity(name);
  return { oid: identity.oid, name: identity.name, email: identity.email! };
}

const ALICE = persona("alice");
const BOB = persona("bob");
const CAROL = persona("carol");

const viewerOf = (who: Person) => ({ ...who, tid: "dev", modelRoute: "own-licence" as const });

/** Long enough for a NOTIFY committed before it to have reached this pod's hub. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250));
}

function request(as: string, path: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, { headers: { cookie: `ah_dev_persona=${as}` } });
}

/** Alice's chat, with one question, one answer and a document. */
async function chat(): Promise<{ id: string; agentId: string }> {
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
    {
      title: "Draft order",
      markdown: "## Draft order\n\nThe property, the date and the costs.",
      baseVersion: 0,
      by: "agent"
    }
  );
  return { id, agentId };
}

beforeAll(async () => {
  await realtime().listener.ready();
});

beforeEach(async () => {
  vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "true");
  vi.stubEnv("SESSION_SECRET", "a-test-session-secret-long-enough-to-be-plausible");
  await resetDatabase();
  await insertUser(ALICE);
  await insertUser(BOB);
  await insertUser(CAROL);
  // Carol can see and message every agent Alice has. No part of that reaches a conversation.
  await setGrant(prisma, ALICE.oid, CAROL.oid, "write");
  actAs("alice");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await realtime().listener.stop();
  await prisma.$disconnect();
});

describe("sharing a conversation", () => {
  it("should let the owner share their chat with a named person and take it back again", async () => {
    const { id } = await chat();

    const shared = await shareActions.shareChat({ conversationId: id, recipientOid: BOB.oid });

    expect(shared).toMatchObject({ ok: true, people: [{ oid: BOB.oid, name: BOB.name, email: BOB.email }] });
    expect(await shareRecipients(prisma, id)).toHaveLength(1);

    expect(await shareActions.unshareChat({ conversationId: id, recipientOid: BOB.oid })).toMatchObject({ ok: true, people: [] });
    expect(await shareRecipients(prisma, id)).toEqual([]);
  });

  it("should change nothing when the owner shares with someone already named", async () => {
    const { id } = await chat();
    await shareActions.shareChat({ conversationId: id, recipientOid: BOB.oid });

    expect(await shareActions.shareChat({ conversationId: id, recipientOid: BOB.oid })).toMatchObject({ ok: true, people: [{ oid: BOB.oid }] });
    expect(await shareRecipients(prisma, id)).toHaveLength(1);
  });

  it("should refuse an owner sharing with someone who has never used the hub", async () => {
    const { id } = await chat();

    expect(await shareActions.shareChat({ conversationId: id, recipientOid: "dev-nobody" })).toEqual({
      ok: false,
      error: "that person has not used the hub yet, so cannot be shared with"
    });
    expect(await shareRecipients(prisma, id)).toEqual([]);
  });

  it("should report a chat that is not the actor's as missing when they try to share it", async () => {
    const { id } = await chat();
    actAs("carol");

    expect(await shareActions.shareChat({ conversationId: id, recipientOid: CAROL.oid })).toEqual({ ok: false, error: "no such conversation" });
    expect(await shareRecipients(prisma, id)).toEqual([]);
  });

  it("should tell the owner's pods that the conversation changed, from inside the transaction that shared it", async () => {
    const { id } = await chat();
    const heard: string[] = [];
    const stop = realtime().hub.subscribe((event) => {
      if (event.type === "assistant_conversation" && event.conversation_id === id) {
        heard.push(event.owner_oid);
      }
    });
    try {
      // The notifies of creating the chat arrive through Postgres, so they can land after this subscription. Settling
      // and then emptying what was heard is what makes each expectation below the share's own announcement.
      await settle();
      heard.length = 0;

      await shareActions.shareChat({ conversationId: id, recipientOid: BOB.oid });
      await vi.waitFor(() => expect(heard).toEqual([ALICE.oid]), { timeout: 5000 });

      heard.length = 0;
      await shareActions.unshareChat({ conversationId: id, recipientOid: BOB.oid });
      await vi.waitFor(() => expect(heard).toEqual([ALICE.oid]), { timeout: 5000 });
    } finally {
      stop();
    }
  });

  it("should say nothing when a share changes nothing", async () => {
    const { id } = await chat();
    await shareActions.shareChat({ conversationId: id, recipientOid: BOB.oid });
    const heard: string[] = [];
    const stop = realtime().hub.subscribe((event) => {
      if (event.type === "assistant_conversation" && event.conversation_id === id) {
        heard.push(event.owner_oid);
      }
    });
    try {
      await settle();
      heard.length = 0;

      // Each of the three writes that leaves the list as it was: a person the hub does not know, a person already
      // named, and a revocation of a share nobody held.
      await shareActions.shareChat({ conversationId: id, recipientOid: "dev-nobody" });
      await shareActions.shareChat({ conversationId: id, recipientOid: BOB.oid });
      await shareActions.unshareChat({ conversationId: id, recipientOid: CAROL.oid });
      await settle();

      expect(heard).toEqual([]);
    } finally {
      stop();
    }
  });
});

describe("reading a shared conversation", () => {
  it("should show a named recipient the words of the thread and the document", async () => {
    const { id } = await chat();
    await shareActions.shareChat({ conversationId: id, recipientOid: BOB.oid });

    const view = await sharedChat(viewerOf(BOB), id);

    expect(view).toMatchObject({
      id,
      title: "What goes in a possession order?",
      ownerName: ALICE.name,
      access: "reader",
      document: { title: "Draft order", markdown: "## Draft order\n\nThe property, the date and the costs." }
    });
    expect(view?.thread.map((item) => ("text" in item ? item.text : item.type))).toEqual([
      "What goes in a possession order?",
      "The property, the date and the costs."
    ]);
  });

  it("should show the owner the same page, so they can see what they shared", async () => {
    const { id } = await chat();
    await shareActions.shareChat({ conversationId: id, recipientOid: BOB.oid });

    expect(await sharedChat(viewerOf(ALICE), id)).toMatchObject({ access: "owner" });
  });

  it("should list the chat for both sides, and for nobody else", async () => {
    const { id } = await chat();
    await shareActions.shareChat({ conversationId: id, recipientOid: BOB.oid });

    expect(await sharedChats(viewerOf(ALICE))).toMatchObject({ given: [{ id, withWhom: "1 person" }], received: [] });
    expect(await sharedChats(viewerOf(BOB))).toMatchObject({ given: [], received: [{ id, withWhom: ALICE.name }] });
    expect(await sharedChats(viewerOf(CAROL))).toEqual({ given: [], received: [] });
  });

  // The thread is read with the owner's own transcript access, so everything their session recorded is in reach of
  // this read: the commands it ran, the files it opened and what came back. `threadItems` keeps only what the
  // assistant said, which is what makes that safe.
  it("should show nothing the session did, only what it said", async () => {
    const { id, agentId } = await chat();
    await prisma.transcriptEntry.createMany({
      data: [
        {
          agentId,
          sessionId: "s",
          entryKey: "tool",
          role: "tool_use",
          content: { name: "Bash", input: { command: "cat /workspace/private-notes.md" } },
          occurredAt: new Date()
        },
        { agentId, sessionId: "s", entryKey: "result", role: "tool_result", content: { text: "the contents of the private notes" }, occurredAt: new Date() },
        { agentId, sessionId: "s", entryKey: "said", role: "assistant", content: { text: "I have read the notes." }, occurredAt: new Date() }
      ]
    });
    await shareActions.shareChat({ conversationId: id, recipientOid: BOB.oid });

    const shown = JSON.stringify(await sharedChat(viewerOf(BOB), id));

    expect(shown).toContain("I have read the notes.");
    expect(shown).not.toContain("private-notes.md");
    expect(shown).not.toContain("the contents of the private notes");
  });

  it("should name no attachment of a shared message, only how many there were", async () => {
    const { id, agentId } = await chat();
    const message = await prisma.message.findFirstOrThrow({ where: { targetAgentId: agentId }, select: { id: true } });
    await prisma.assistantUpload.create({
      data: {
        conversationId: id,
        ownerOid: ALICE.oid,
        messageId: message.id,
        fileName: "medical-report.pdf",
        storedName: "medical-report.pdf",
        mediaType: "application/pdf",
        bytes: 2048,
        state: "fetched"
      }
    });
    await shareActions.shareChat({ conversationId: id, recipientOid: BOB.oid });

    const view = await sharedChat(viewerOf(BOB), id);

    expect(view?.thread[0]).toMatchObject({ type: "user", attachmentCount: 1 });
    expect(JSON.stringify(view)).not.toContain("medical-report.pdf");
  });
});

/**
 * The test that matters. Carol is signed in, holds a write grant over every agent Alice has, and has been handed
 * the exact address of the share — the conversation's id is the whole of the link. Each expectation below asserts
 * that she learns nothing from it: not the page, not who it is shared with, not the thread through the conversation's
 * agent on the hub's API, not the agent on the roster, and not a live event through the UI stream. The id is all a
 * link carries, so "handed the link" and "knows the id" are the same thing, and this is what proves a link does not
 * grant access.
 */
describe("a stranger handed the link", () => {
  it("should see nothing of the conversation, however close to it their other access is", async () => {
    const { id, agentId } = await chat();
    await shareActions.shareChat({ conversationId: id, recipientOid: BOB.oid });

    // The share page, which is what the link opens.
    expect(await sharedChat(viewerOf(CAROL), id)).toBeUndefined();
    // The owner's own page for the same conversation.
    expect(await assistantConversation(viewerOf(CAROL), id)).toBeUndefined();
    // Who it is shared with.
    expect(await chatShares(viewerOf(CAROL), id)).toBeUndefined();
    // The conversation's agent, on the agent API's roster.
    const roster = await jsonOf<{ agents: { agent_id: string }[] }>(await call(agentsRoster, { as: CAROL, path: "/api/agent/agents" }));
    expect(roster.agents.map((agent) => agent.agent_id)).not.toContain(agentId);
    // A live watch on the conversation's agent, which is how the thread would reach her browser.
    expect((await stream(request("carol", `/api/ui/stream?agent=${agentId}`))).status).toBe(404);
  });

  // Sharing and the sidebar's search were built separately, and this is where they meet: a share is of one chat,
  // reached by its own address, and does not put that chat into anyone else's search. Being able to read something
  // is not the same as having it offered among your own chats.
  it("should not put a shared chat into the recipient's search, nor anyone else's", async () => {
    const { id } = await chat();
    await shareActions.shareChat({ conversationId: id, recipientOid: BOB.oid });

    expect((await conversationMatches(prisma, ALICE.oid, "possession")).map((match) => match.id)).toEqual([id]);
    expect(await conversationMatches(prisma, BOB.oid, "possession")).toEqual([]);
    expect(await conversationMatches(prisma, CAROL.oid, "possession")).toEqual([]);
  });

  it("should be refused the same way whether the conversation exists or not", async () => {
    const { id } = await chat();

    expect(await sharedChat(viewerOf(CAROL), id)).toBeUndefined();
    expect(await sharedChat(viewerOf(CAROL), "6fa0f2f5-3c2f-4a3f-8a1f-2b0c9d4e5f60")).toBeUndefined();
    expect(await sharedChat(viewerOf(CAROL), "not-a-uuid")).toBeUndefined();
  });
});

/** Read-only means read-only: a recipient has the page and nothing else, on every surface that could change a chat. */
describe("what a recipient cannot do", () => {
  it("should refuse a recipient sending, renaming, deleting or editing the document", async () => {
    const { id } = await chat();
    await shareActions.shareChat({ conversationId: id, recipientOid: BOB.oid });
    const before = await prisma.message.count();
    actAs("bob");

    expect(await assistantActions.sendAssistantMessage({ conversationId: id, body: "Can I add something?" })).toEqual({
      ok: false,
      error: "that conversation no longer exists"
    });
    expect(await assistantActions.renameConversation({ conversationId: id, title: "Mine now" })).toEqual({ ok: false, error: "no such conversation" });
    expect(await assistantActions.setConversationProduct({ conversationId: id, product: "ccd" })).toEqual({ ok: false, error: "no such conversation" });
    expect(await assistantActions.saveArtefact({ conversationId: id, title: "Theirs", markdown: "rewritten", baseVersion: 1 })).toEqual({
      ok: false,
      error: "that conversation no longer exists"
    });
    expect(await assistantActions.deleteConversation({ conversationId: id })).toEqual({ ok: false, error: "no such conversation" });

    expect(await prisma.message.count()).toBe(before);
    expect(await prisma.assistantConversation.findUniqueOrThrow({ where: { id }, select: { title: true, product: true } })).toEqual({
      title: "What goes in a possession order?",
      product: "general"
    });
    expect(await readArtefact(prisma, id)).toMatchObject({ title: "Draft order", version: 1 });
  });

  it("should refuse a recipient sharing the chat on with someone else", async () => {
    const { id } = await chat();
    await shareActions.shareChat({ conversationId: id, recipientOid: BOB.oid });
    actAs("bob");

    expect(await shareActions.shareChat({ conversationId: id, recipientOid: CAROL.oid })).toEqual({ ok: false, error: "no such conversation" });
    expect(await shareRecipients(prisma, id)).toHaveLength(1);
  });

  it("should give a recipient no more of the conversation's agent than a stranger has", async () => {
    const { id, agentId } = await chat();
    await shareActions.shareChat({ conversationId: id, recipientOid: BOB.oid });

    expect(await assistantConversation(viewerOf(BOB), id)).toBeUndefined();
    const roster = await jsonOf<{ agents: { agent_id: string }[] }>(await call(agentsRoster, { as: BOB, path: "/api/agent/agents" }));
    expect(roster.agents.map((agent) => agent.agent_id)).not.toContain(agentId);
    expect((await stream(request("bob", `/api/ui/stream?agent=${agentId}`))).status).toBe(404);
  });
});

describe("revoking a share", () => {
  it("should stop the recipient reading the chat from their next read", async () => {
    const { id } = await chat();
    await shareActions.shareChat({ conversationId: id, recipientOid: BOB.oid });
    expect(await sharedChat(viewerOf(BOB), id)).toMatchObject({ access: "reader" });

    await shareActions.unshareChat({ conversationId: id, recipientOid: BOB.oid });

    expect(await sharedChat(viewerOf(BOB), id)).toBeUndefined();
    expect(await sharedChats(viewerOf(BOB))).toEqual({ given: [], received: [] });
  });

  it("should take the shares with the conversation when the owner deletes it", async () => {
    const { id } = await chat();
    await shareActions.shareChat({ conversationId: id, recipientOid: BOB.oid });

    expect(await assistantActions.deleteConversation({ conversationId: id })).toMatchObject({ ok: true });

    expect(await prisma.assistantConversationShare.count()).toBe(0);
    expect(await sharedChat(viewerOf(BOB), id)).toBeUndefined();
  });

  // The share row names two people as well as the conversation, so either of them going takes it with them. Without
  // the cascade on the recipient, a row would be left pointing at an oid nobody holds, and the share list would read
  // it as a person.
  it("should take the share with the recipient when that person's row goes", async () => {
    const { id } = await chat();
    await shareActions.shareChat({ conversationId: id, recipientOid: BOB.oid });

    await prisma.user.delete({ where: { oid: BOB.oid } });

    expect(await prisma.assistantConversationShare.count()).toBe(0);
    expect(await shareRecipients(prisma, id)).toEqual([]);
    expect(await prisma.assistantConversation.count({ where: { id } })).toBe(1);
  });
});

describe("the owner's own chat", () => {
  it("should be unchanged by sharing it", async () => {
    const { id } = await chat();
    const before = await assistantConversation(viewerOf(ALICE), id);

    await shareActions.shareChat({ conversationId: id, recipientOid: BOB.oid });

    expect(await assistantConversation(viewerOf(ALICE), id)).toEqual(before);
  });

  it("should still take the owner's own message, rename and document edit while it is shared", async () => {
    const { id } = await chat();
    await shareActions.shareChat({ conversationId: id, recipientOid: BOB.oid });

    expect(await assistantActions.sendAssistantMessage({ conversationId: id, body: "And the costs?" })).toMatchObject({ ok: true });
    expect(await assistantActions.renameConversation({ conversationId: id, title: "Possession orders" })).toMatchObject({ ok: true });
    expect(await assistantActions.saveArtefact({ conversationId: id, title: "Draft order", markdown: "Still mine", baseVersion: 1 })).toMatchObject({
      ok: true,
      saved: true
    });
  });
});

describe("/api/ui/people", () => {
  it("should offer the people the hub knows whose name starts a word with the query", async () => {
    const answered = await jsonOf<{ people: { oid: string; name: string }[] }>(await people(request("alice", "/api/ui/people?q=bob")));

    expect(answered.people).toEqual([{ oid: BOB.oid, name: BOB.name, email: BOB.email }]);
  });

  it("should never offer the person asking", async () => {
    const answered = await jsonOf<{ people: { oid: string }[] }>(await people(request("alice", "/api/ui/people?q=dev")));

    expect(answered.people.map((person) => person.oid)).toEqual([BOB.oid, CAROL.oid]);
  });

  it("should answer a query too short to be specific with nobody, rather than with everyone", async () => {
    for (const query of ["", "d"]) {
      expect(await jsonOf<{ people: unknown[] }>(await people(request("alice", `/api/ui/people?q=${query}`)))).toEqual({ people: [] });
    }
  });

  it("should treat a typed wildcard as text, so it matches nobody", async () => {
    expect(await jsonOf<{ people: unknown[] }>(await people(request("alice", "/api/ui/people?q=%25e")))).toEqual({ people: [] });
  });
});
