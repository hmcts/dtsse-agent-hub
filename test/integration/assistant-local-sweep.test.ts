// The sweep that bounds how many conversations a person's own Claude Code sessions can put in their Assistant.
//
// Two things are under test and the second is the one that matters. The first is which conversations it collects: an
// empty one goes, and a `/clear` leftover holding a transcript, a chat that was spoken in, a chat whose document was
// written and a chat whose session is still running all stay. The second is that collecting one cascades to nothing:
// `agent.assistant_conversation_id` is `ON DELETE CASCADE` and the agent's own dependants cascade from there, so a
// delete that did not detach the session first would take the live agent row, its transcript, its subscriptions and
// every message to or from it — which was the worst bug on this branch.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_CONVERSATION_RETENTION_HOURS, startLocalConversationSweep, sweepLocalConversations } from "../../src/assistant/local-sweep.ts";
import { createConversation, ensureAssistant, linkLocalSession } from "../../src/assistant/store.ts";
import { createDirect, createPost } from "../../src/messages/store.ts";
import { decodeEvent, HUB_CHANNEL } from "../../src/realtime/events.ts";
import { subscribe } from "../../src/topics/store.ts";
import { connect, insertAgent, insertUser, person, prisma, resetDatabase } from "./database.ts";
import { until } from "./waits.ts";

const ALICE = person("alice");
const BOB = person("bob");

/** Longer ago than the retention window, which is what both of the sweep's clocks are measured against. */
const STALE = new Date(Date.now() - (LOCAL_CONVERSATION_RETENTION_HOURS + 1) * 3_600_000);
/** Inside the window. */
const RECENT = new Date(Date.now() - 3_600_000);

beforeEach(async () => {
  await resetDatabase();
  await insertUser(ALICE);
  await insertUser(BOB);
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * A chat that is a Claude Code session on Alice's own computer, as `registerAgent` makes one, with its session last
 * heard from at `heardAt` and the conversation created then too.
 *
 * Both are backdated, because the sweep reads both: a helper that aged only the conversation would be arranging
 * something that cannot happen, since the agent is registered in the same breath as the conversation is made.
 */
async function laptopChat(name: string, heardAt: Date): Promise<{ conversationId: string; agentId: string; sessionId: string }> {
  const agentId = await insertAgent(ALICE, name, { status: "offline", lastHeartbeatAt: heardAt });
  const conversation = await linkLocalSession(prisma, { ownerOid: ALICE.oid, agentId, name });
  if (conversation === undefined) {
    throw new Error("the agent was already in a conversation");
  }
  await prisma.assistantConversation.update({ where: { id: conversation.id }, data: { createdAt: heardAt } });
  const { sessionId } = await prisma.agent.findUniqueOrThrow({ where: { id: agentId }, select: { sessionId: true } });
  return { conversationId: conversation.id, agentId, sessionId };
}

async function addTranscript(agentId: string, sessionId: string, key: string): Promise<void> {
  await prisma.transcriptEntry.create({
    data: { agentId, sessionId, entryKey: key, role: "assistant", content: { text: "it ran on the offline clock" }, occurredAt: STALE }
  });
}

function countOf(conversationId: string): Promise<number> {
  return prisma.assistantConversation.count({ where: { id: conversationId } });
}

describe("sweepLocalConversations", () => {
  it("should collect a chat on somebody's own computer that nothing ever happened in", async () => {
    const chat = await laptopChat("alices-laptop", STALE);

    expect(await sweepLocalConversations(prisma)).toEqual({ collected: 1 });

    expect(await countOf(chat.conversationId)).toBe(0);
  });

  /**
   * A `/clear` mints a new session id, so the bridge registers a new agent and is given a new conversation; the
   * superseded session keeps its own, with the whole of whatever was done in it. That is a chat the person can still
   * read, and the only thing about it that looks collectable is that nothing is running it.
   */
  it("should leave a /clear leftover, whose superseded session holds the transcript of the work", async () => {
    const cleared = await laptopChat("alices-laptop", STALE);
    await addTranscript(cleared.agentId, cleared.sessionId, "before-the-clear");
    const after = await laptopChat("alices-laptop", RECENT);

    expect(await sweepLocalConversations(prisma)).toEqual({ collected: 0 });

    expect(await countOf(cleared.conversationId)).toBe(1);
    expect(await prisma.transcriptEntry.count({ where: { agentId: cleared.agentId } })).toBe(1);
    expect(await countOf(after.conversationId)).toBe(1);
  });

  it("should leave a chat that was spoken in, however long ago its session went quiet", async () => {
    const chat = await laptopChat("alices-laptop", STALE);
    await createDirect(prisma, { author: { oid: ALICE.oid, agentId: null }, targetAgentId: chat.agentId, inReplyTo: null, body: "where did that go?" });

    expect(await sweepLocalConversations(prisma)).toEqual({ collected: 0 });

    expect(await countOf(chat.conversationId)).toBe(1);
  });

  // The thread merges a colleague's directs with the transcript, so a message from somebody else is words in this
  // chat as much as the person's own are.
  it("should leave a chat a colleague messaged the session in", async () => {
    const chat = await laptopChat("alices-laptop", STALE);
    const bobs = await insertAgent(BOB, "bobs-laptop");
    await createDirect(prisma, { author: { oid: BOB.oid, agentId: bobs }, targetAgentId: chat.agentId, inReplyTo: null, body: "look at this" });

    expect(await sweepLocalConversations(prisma)).toEqual({ collected: 0 });

    expect(await countOf(chat.conversationId)).toBe(1);
  });

  it("should leave a chat whose session asked a question, which the thread shows as a card", async () => {
    const chat = await laptopChat("alices-laptop", STALE);
    await prisma.agentQuestion.create({
      data: { agentId: chat.agentId, sessionId: chat.sessionId, toolUseId: "t1", questions: [{ question: "which branch?", options: [] }], askedAt: STALE }
    });

    expect(await sweepLocalConversations(prisma)).toEqual({ collected: 0 });

    expect(await countOf(chat.conversationId)).toBe(1);
  });

  // A person can write a local chat's document themselves: it is a hub row, and `saveArtefact` works there.
  it("should leave a chat whose document was written, even with nothing said in it", async () => {
    const chat = await laptopChat("alices-laptop", STALE);
    await prisma.assistantConversation.update({ where: { id: chat.conversationId }, data: { artefactVersion: 1, artefactMarkdown: "# what I found" } });

    expect(await sweepLocalConversations(prisma)).toEqual({ collected: 0 });

    expect(await countOf(chat.conversationId)).toBe(1);
  });

  /**
   * The condition that keeps a developer's working day out of this. A session registers before anybody types into it,
   * so the window has to run on the session's own clock and not only on the conversation's age — otherwise a chat
   * opened while its owner reads would be swept out from under them.
   */
  it("should leave a chat whose session was heard from inside the window, however old the chat is", async () => {
    const agentId = await insertAgent(ALICE, "alices-laptop", { status: "idle", lastHeartbeatAt: RECENT });
    const conversation = (await linkLocalSession(prisma, { ownerOid: ALICE.oid, agentId, name: "alices-laptop" }))!;
    await prisma.assistantConversation.update({ where: { id: conversation.id }, data: { createdAt: STALE } });

    expect(await sweepLocalConversations(prisma)).toEqual({ collected: 0 });

    expect(await countOf(conversation.id)).toBe(1);
  });

  it("should leave a chat created inside the window", async () => {
    const chat = await laptopChat("alices-laptop", RECENT);

    expect(await sweepLocalConversations(prisma)).toEqual({ collected: 0 });

    expect(await countOf(chat.conversationId)).toBe(1);
  });

  // Those belong to `dropAbandoned` in `upload-sweep.ts`, which has its own window and its own conditions; two
  // sweeps owning one row is how one of them ends up deleting something the other was keeping.
  it("should leave an empty chat that has a pod, which the upload sweep owns", async () => {
    await ensureAssistant(prisma, { oid: ALICE.oid, modelRoute: "own-licence" });
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    await prisma.assistantConversation.update({ where: { id: conversation.id }, data: { createdAt: STALE } });

    expect(await sweepLocalConversations(prisma)).toEqual({ collected: 0 });

    expect(await countOf(conversation.id)).toBe(1);
  });

  it("should collect no more than a batch at a time, so a backlog drains over a few ticks", async () => {
    await laptopChat("one", STALE);
    await laptopChat("two", STALE);
    await laptopChat("three", STALE);

    expect(await sweepLocalConversations(prisma, { batch: 2 })).toEqual({ collected: 2 });
    expect(await sweepLocalConversations(prisma, { batch: 2 })).toEqual({ collected: 1 });
    expect(await sweepLocalConversations(prisma, { batch: 2 })).toEqual({ collected: 0 });
  });

  it("should stand down while another pod holds the sweep lock", async () => {
    const chat = await laptopChat("alices-laptop", STALE);
    const other = await connect();
    try {
      await other.query("BEGIN");
      await other.query("SELECT pg_advisory_xact_lock($1)", [0x6c636c63_73776570n.toString()]);

      expect(await sweepLocalConversations(prisma)).toBeUndefined();
      expect(await countOf(chat.conversationId)).toBe(1);

      await other.query("COMMIT");
      expect(await sweepLocalConversations(prisma)).toEqual({ collected: 1 });
    } finally {
      await other.end();
    }
  });

  it("should announce each deletion, so a sidebar still open stops showing a chat that has gone", async () => {
    const chat = await laptopChat("alices-laptop", STALE);
    const listener = await connect();
    try {
      const heard: unknown[] = [];
      listener.on("notification", (notification) => {
        const event = decodeEvent(notification.payload);
        if (event?.type === "assistant_conversation") {
          heard.push(event);
        }
      });
      await listener.query(`LISTEN ${HUB_CHANNEL}`);

      expect(await sweepLocalConversations(prisma)).toEqual({ collected: 1 });

      await listener.query("SELECT 1");
      expect(heard).toEqual([{ type: "assistant_conversation", conversation_id: chat.conversationId, virtual_agent_id: null, owner_oid: ALICE.oid }]);
    } finally {
      await listener.end();
    }
  });
});

/**
 * The cascade, which is the whole reason this sweep detaches before it deletes. The chat is collectable — nothing was
 * ever said in it and its session uploaded nothing — while the session itself is an ordinary agent on the roster,
 * with topic subscriptions, posts it wrote to the boards and a post of somebody else's pushed to it. None of that is
 * the chat, and none of it may go with the chat.
 */
describe("sweepLocalConversations and the agent it detaches", () => {
  it("should leave the session's agent row, its subscriptions, its posts and its deliveries standing", async () => {
    const chat = await laptopChat("alices-laptop", STALE);
    await subscribe(prisma, chat.agentId, ["pcs"]);
    const ownPost = await createPost(prisma, {
      author: { oid: ALICE.oid, agentId: chat.agentId },
      topics: ["pcs"],
      title: null,
      body: "what I found",
      inReplyTo: null
    });
    const bobs = await insertAgent(BOB, "bobs-laptop");
    const tagging = await createPost(prisma, {
      author: { oid: BOB.oid, agentId: bobs },
      topics: ["pcs"],
      title: null,
      body: "have a look",
      inReplyTo: null,
      taggedAgentIds: [chat.agentId]
    });

    expect(await sweepLocalConversations(prisma)).toEqual({ collected: 1 });

    expect(await countOf(chat.conversationId)).toBe(0);
    // Detached rather than deleted, which is the one thing that must be true of every path that removes a local chat.
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: chat.agentId }, select: { assistantConversationId: true } })).toEqual({
      assistantConversationId: null
    });
    expect(await prisma.subscription.count({ where: { agentId: chat.agentId } })).toBe(1);
    expect(await prisma.message.count({ where: { id: { in: [BigInt(ownPost.id), BigInt(tagging.id)] } } })).toBe(2);
    expect(await prisma.messageTag.count({ where: { agentId: chat.agentId } })).toBe(1);
    expect(await prisma.delivery.count({ where: { agentId: chat.agentId } })).toBe(1);
  });

  // The other chat's transcript is the one a cascade would reach through a shared `agent` row, and there is no such
  // sharing: each session has its own agent, so collecting one chat cannot touch another's words.
  it("should leave another chat's transcript standing when it collects an empty one beside it", async () => {
    const empty = await laptopChat("alices-laptop", STALE);
    const worked = await laptopChat("alices-other-laptop", STALE);
    await addTranscript(worked.agentId, worked.sessionId, "a-days-work");

    expect(await sweepLocalConversations(prisma)).toEqual({ collected: 1 });

    expect(await countOf(empty.conversationId)).toBe(0);
    expect(await countOf(worked.conversationId)).toBe(1);
    expect(await prisma.transcriptEntry.count({ where: { agentId: worked.agentId } })).toBe(1);
    expect(await prisma.agent.count({ where: { id: { in: [empty.agentId, worked.agentId] } } })).toBe(2);
  });
});

describe("startLocalConversationSweep", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should collect on its interval, say what it took, and say nothing for a tick that found nothing", async () => {
    const chat = await laptopChat("alices-laptop", STALE);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const transaction = vi.spyOn(prisma, "$transaction");

    const sweeper = startLocalConversationSweep(prisma, 10);
    try {
      await until(() => info.mock.calls.length > 0);
      // Two more ticks after the one that took it, so the quiet is a tick that ran and found nothing rather than a
      // tick that had yet to happen.
      const calls = transaction.mock.calls.length;
      await until(() => transaction.mock.calls.length >= calls + 2);
    } finally {
      await sweeper.stop();
    }

    expect(info.mock.calls).toEqual([["local chat sweep: 1 chats on people's own computers deleted, nothing having ever happened in them"]]);
    expect(await countOf(chat.conversationId)).toBe(0);
  });
});
