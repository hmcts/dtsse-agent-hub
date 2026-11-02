import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { heartbeat, registerAgent } from "../../src/agents/store.ts";
import { acceptFork, offerFork } from "../../src/assistant/fork-store.ts";
import { sweepLocalConversations } from "../../src/assistant/local-sweep.ts";
import {
  type ConversationRow,
  conversationAgent,
  createConversation,
  deleteConversation,
  ensureAssistant,
  hasLocalConversation,
  listConversations,
  renameConversation,
  searchConversations,
  touchConversation,
  unsentConversation,
  writeArtefact
} from "../../src/assistant/store.ts";
import { directAsPerson } from "../../src/messages/send.ts";
import { createDirect } from "../../src/messages/store.ts";
import { recordQuestion } from "../../src/questions/store.ts";
import { decodeEvent, HUB_CHANNEL } from "../../src/realtime/events.ts";
import { RETENTION_DAYS } from "../../src/transcripts/limits.ts";
import type { NewTranscriptEntry } from "../../src/transcripts/schema.ts";
import { appendEntries } from "../../src/transcripts/store.ts";
import { sweepTranscripts } from "../../src/transcripts/sweep.ts";
import { connect, insertAgent, insertUser, person, prisma, resetDatabase } from "./database.ts";

/**
 * Which chats the sidebar and its search leave out for having nothing in them (`first_content_at`, which
 * `announceFirstContent` in src/assistant/store.ts sets), and the announcement that puts a chat in an open sidebar the
 * moment something is in it.
 */

const ALICE = person("alice");
const BOB = person("bob");

const IDE = "<ide_opened_file>The user opened the file /a/b.ts in the IDE.</ide_opened_file>";
const CLEAR = "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>";

beforeEach(async () => {
  await resetDatabase();
  await insertUser(ALICE);
  await ensureAssistant(prisma, { oid: ALICE.oid, modelRoute: "own-licence" });
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function listed(): Promise<string[]> {
  return (await listConversations(prisma, ALICE.oid)).map((chat) => chat.id);
}

async function found(query: string): Promise<string[]> {
  return (await searchConversations(prisma, ALICE.oid, query)).map((chat) => chat.id);
}

/** A chat on Alice's assistant called "Possession letter", which the search can find by its title alone. */
async function podChat(): Promise<{ conversation: ConversationRow; agentId: string }> {
  const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
  await renameConversation(prisma, ALICE.oid, conversation.id, "Possession letter");
  return { conversation, agentId: await conversationAgent(prisma, conversation) };
}

/** A file the new-chat screen attached to the conversation and nobody has sent yet. */
async function attached(conversationId: string): Promise<void> {
  await prisma.assistantUpload.create({
    data: {
      conversationId,
      ownerOid: ALICE.oid,
      fileName: "letter.pdf",
      storedName: "letter.pdf",
      mediaType: "application/pdf",
      bytes: 10n,
      state: "stored"
    }
  });
}

/** Alice's Claude Code session on her laptop, as it registers, with the chat the hub makes for it. */
async function laptopChat(sessionId = "alices-laptop", nameSource?: "user"): Promise<{ conversationId: string; agentId: string }> {
  const agent = await registerAgent(
    prisma,
    { ...ALICE, tid: "dev" },
    { sessionId, name: "possession-work", cwd: null, repo: null, branch: null, host: null, ...(nameSource === undefined ? {} : { nameSource }) }
  );
  const row = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id }, select: { assistantConversationId: true } });
  return { conversationId: row.assistantConversationId!, agentId: agent.id };
}

function entry(key: string, role: "user" | "assistant", text: string): NewTranscriptEntry {
  return { key, role, content: { text }, truncated: false, redacted: false, message_id: null, occurred_at: new Date() } as NewTranscriptEntry;
}

async function uploaded(agentId: string, entries: readonly NewTranscriptEntry[]): Promise<void> {
  await appendEntries(prisma, { id: agentId, ownerOid: ALICE.oid }, "s-1", entries);
}

/** How many `assistant_conversation` events for the conversation `act` sent, heard on the hub's channel. */
async function announcements(conversationId: string, act: () => Promise<unknown>): Promise<number> {
  const listener = await connect();
  try {
    let heard = 0;
    listener.on("notification", (notification) => {
      const event = decodeEvent(notification.payload);
      if (event?.type === "assistant_conversation" && event.conversation_id === conversationId) {
        heard += 1;
      }
    });
    await listener.query(`LISTEN ${HUB_CHANNEL}`);
    await act();
    await listener.query("SELECT 1");
    return heard;
  } finally {
    await listener.end();
  }
}

const QUESTION = {
  session_id: "s-1",
  tool_use_id: "toolu_first",
  questions: [
    {
      question: "Which claim?",
      header: "Claim",
      options: [
        { label: "Mine", description: "Your claim." },
        { label: "Theirs", description: "Their claim." }
      ],
      multiSelect: false
    }
  ]
};

describe("a chat on a pod with nothing in it", () => {
  it("should be left out of the list and the search and still be resumed by the new-chat screen when it was opened for a file nobody sent", async () => {
    const { conversation } = await podChat();
    await attached(conversation.id);

    expect(await listed()).toEqual([]);
    expect(await found("possession")).toEqual([]);
    expect((await unsentConversation(prisma, ALICE.oid))?.id).toBe(conversation.id);
  });

  it("should be listed and found when the person's first message is sent in it", async () => {
    const { conversation, agentId } = await podChat();
    await attached(conversation.id);

    await directAsPerson(prisma, ALICE.oid, agentId, "what does this letter say?");
    await touchConversation(prisma, conversation, "what does this letter say?");

    expect(await listed()).toEqual([conversation.id]);
    expect(await found("letter")).toEqual([conversation.id]);
    expect(await unsentConversation(prisma, ALICE.oid)).toBeUndefined();
  });

  it("should be listed and found when all it holds is a document", async () => {
    const { conversation } = await podChat();

    await writeArtefact(prisma, conversation, { title: "Plan", markdown: "# Plan", baseVersion: 0, by: "agent" });

    expect(await listed()).toEqual([conversation.id]);
    expect(await found("possession")).toEqual([conversation.id]);
  });

  it("should be listed and found when all it holds is a question its session asked", async () => {
    const { conversation, agentId } = await podChat();

    await recordQuestion(prisma, { id: agentId, ownerOid: ALICE.oid }, QUESTION);

    expect(await listed()).toEqual([conversation.id]);
    expect(await found("possession")).toEqual([conversation.id]);
  });

  it("should list the copy when the person takes a fork of somebody else's chat", async () => {
    await insertUser(BOB);
    await ensureAssistant(prisma, { oid: BOB.oid, modelRoute: "own-licence" });
    const source = await createConversation(prisma, BOB.oid, { product: "pcs", title: "Possession letter" });
    await directAsPerson(prisma, BOB.oid, await conversationAgent(prisma, source), "what does this letter say?");
    await offerFork(prisma, BOB.oid, source.id, ALICE.oid);

    const copy = await acceptFork(prisma, { oid: ALICE.oid, modelRoute: "own-licence" }, source.id);

    expect(await listed()).toEqual([copy]);
  });
});

describe("a chat on the person's own computer whose thread shows nothing but notices", () => {
  it.each([
    ["editor context alone", IDE],
    ["editor context and whitespace JavaScript trims", `${IDE}\n<ide_selection>x</ide_selection>\u00a0\u3000`],
    ["a slash command after editor context", `${IDE}${CLEAR}`],
    ["a local command's output", "<local-command-stdout>Set model to opus</local-command-stdout>"],
    ["a system reminder", "<system-reminder>be brief</system-reminder>"],
    ["a background task's notification", "<task-notification><status>completed</status><summary>done</summary></task-notification>"]
  ])("should be left out of the list, the search and the cloud-mark check when its only user turn is %s", async (_, text) => {
    const { agentId } = await laptopChat();

    await uploaded(agentId, [entry("1", "user", text)]);

    expect(await listed()).toEqual([]);
    expect(await found("possession")).toEqual([]);
    expect(await hasLocalConversation(prisma, ALICE.oid)).toBe(false);
  });

  it("should be left out when its only answer has no words in it", async () => {
    const { agentId } = await laptopChat();

    await uploaded(agentId, [entry("1", "assistant", "  ")]);

    expect(await listed()).toEqual([]);
  });

  it.each([
    ["words after the editor context", `${IDE}\nwhy is the possession claim stuck?`],
    ["a shell command run with !", "<bash-input>ls</bash-input>"],
    ["a shell command's output", "<bash-stdout>a.txt</bash-stdout><bash-stderr></bash-stderr>"],
    ["a prompt hook's output", "<user-prompt-submit-hook>checked</user-prompt-submit-hook>"],
    ["an interrupted request", "[Request interrupted by user]"]
  ])("should be listed when its only user turn is %s, which its thread shows as a bubble", async (_, text) => {
    const { conversationId, agentId } = await laptopChat();

    await uploaded(agentId, [entry("1", "user", text)]);

    expect(await listed()).toEqual([conversationId]);
    expect(await hasLocalConversation(prisma, ALICE.oid)).toBe(true);
  });

  it("should be listed when its only content is a tool call", async () => {
    const { conversationId, agentId } = await laptopChat();

    await uploaded(agentId, [
      {
        key: "1",
        role: "tool_use",
        content: { id: "t", name: "Read", input: {} },
        truncated: false,
        redacted: false,
        message_id: null,
        occurred_at: new Date()
      } as NewTranscriptEntry
    ]);

    expect(await listed()).toEqual([conversationId]);
  });
});

describe("a chat linked to a session that has already said something", () => {
  it("should stay unlisted when a heartbeat links it, and be listed when the session next says something", async () => {
    const agentId = await insertAgent(ALICE, "running-all-along");
    await appendEntries(prisma, { id: agentId, ownerOid: ALICE.oid }, "s-1", [entry("1", "assistant", "Hello.")]);

    await heartbeat(prisma, agentId, "idle", "running-all-along");

    const { assistantConversationId } = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(assistantConversationId).not.toBeNull();
    expect(await listed()).toEqual([]);

    await appendEntries(prisma, { id: agentId, ownerOid: ALICE.oid }, "s-1", [entry("2", "assistant", "Anything else?")]);

    expect(await listed()).toEqual([assistantConversationId]);
  });

  it("should keep a deleted chat out of the list when its session heartbeats, until the session says something new", async () => {
    const { conversationId, agentId } = await laptopChat();
    await uploaded(agentId, [entry("1", "user", "look at the possession claim")]);
    await deleteConversation(prisma, ALICE.oid, conversationId);

    await heartbeat(prisma, agentId, "idle", "possession-work");

    const { assistantConversationId } = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(assistantConversationId).not.toBe(conversationId);
    expect(await listed()).toEqual([]);

    expect(await announcements(assistantConversationId!, () => uploaded(agentId, [entry("2", "user", "and the next claim")]))).toBe(1);

    expect(await listed()).toEqual([assistantConversationId]);
    expect((await prisma.assistantConversation.findUniqueOrThrow({ where: { id: assistantConversationId! } })).title).toBe("look at the possession claim");
  });
});

describe("a chat on the person's own computer whose transcript has been swept", () => {
  it("should stay listed and not be collected when everything it held has aged out", async () => {
    const { conversationId, agentId } = await laptopChat();
    await uploaded(agentId, [entry("1", "user", "look at the possession claim")]);
    const old = new Date(Date.now() - (RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000);
    await prisma.transcriptEntry.updateMany({ where: { agentId }, data: { createdAt: old } });
    await prisma.agent.update({ where: { id: agentId }, data: { lastHeartbeatAt: old } });
    await prisma.assistantConversation.update({ where: { id: conversationId }, data: { createdAt: old } });

    expect((await sweepTranscripts(prisma))?.expired).toBe(1);
    expect(await sweepLocalConversations(prisma)).toEqual({ collected: 0 });

    expect(await prisma.transcriptEntry.count({ where: { agentId } })).toBe(0);
    expect(await listed()).toEqual([conversationId]);
    expect(await found("possession")).toEqual([conversationId]);
  });

  it("should still be collected when nothing was ever in it", async () => {
    const { conversationId, agentId } = await laptopChat();
    await uploaded(agentId, [entry("1", "user", CLEAR)]);
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await prisma.agent.update({ where: { id: agentId }, data: { lastHeartbeatAt: old } });
    await prisma.assistantConversation.update({ where: { id: conversationId }, data: { createdAt: old } });
    await prisma.transcriptEntry.deleteMany({ where: { agentId } });

    expect(await sweepLocalConversations(prisma)).toEqual({ collected: 1 });
  });
});

describe("announcing a chat once something is in it", () => {
  it("should announce it once when its first content is an answer, which renames nothing", async () => {
    const { conversationId, agentId } = await laptopChat();

    expect(await announcements(conversationId, () => uploaded(agentId, [entry("1", "assistant", "Hello.")]))).toBe(1);
    expect(await listed()).toEqual([conversationId]);
  });

  it("should announce it once, not twice, when its first prompt also names it", async () => {
    const { conversationId, agentId } = await laptopChat();

    expect(await announcements(conversationId, () => uploaded(agentId, [entry("1", "user", "look at the possession claim")]))).toBe(1);
    expect((await prisma.assistantConversation.findUniqueOrThrow({ where: { id: conversationId } })).title).toBe("look at the possession claim");
  });

  it("should announce it when its first prompt arrives with the title already the name the person gave the session", async () => {
    const { conversationId, agentId } = await laptopChat("renamed", "user");

    expect(await announcements(conversationId, () => uploaded(agentId, [entry("1", "user", "look at the possession claim")]))).toBe(1);
    expect((await prisma.assistantConversation.findUniqueOrThrow({ where: { id: conversationId } })).title).toBe("possession-work");
  });

  it("should announce it for the first batch with content only when harness turns, an answer and another answer arrive in turn", async () => {
    const { conversationId, agentId } = await laptopChat();

    expect(await announcements(conversationId, () => uploaded(agentId, [entry("1", "user", CLEAR), entry("2", "user", IDE)]))).toBe(0);
    expect(await announcements(conversationId, () => uploaded(agentId, [entry("3", "assistant", "Hello.")]))).toBe(1);
    expect(await announcements(conversationId, () => uploaded(agentId, [entry("4", "assistant", "Anything else?")]))).toBe(0);
  });

  it("should announce it once when a direct message from another of the person's sessions is the first thing in it and a second follows", async () => {
    const { conversationId, agentId } = await laptopChat();
    const other = await insertAgent(ALICE, "other-session");
    const send = () =>
      createDirect(prisma, { author: { oid: ALICE.oid, agentId: other }, targetAgentId: agentId, inReplyTo: null, body: "the claim is stuck" });

    expect(await announcements(conversationId, send)).toBe(1);
    expect(await announcements(conversationId, send)).toBe(0);
    expect(await listed()).toEqual([conversationId]);
  });

  it("should announce it when the first thing in it is a direct message its session sent", async () => {
    const { conversationId, agentId } = await laptopChat();
    const other = await insertAgent(ALICE, "other-session");

    expect(
      await announcements(conversationId, () =>
        createDirect(prisma, { author: { oid: ALICE.oid, agentId }, targetAgentId: other, inReplyTo: null, body: "over to you" })
      )
    ).toBe(1);
  });

  it("should announce it when the first thing in it is a question its session asked", async () => {
    const { conversationId, agentId } = await laptopChat();

    expect(await announcements(conversationId, () => recordQuestion(prisma, { id: agentId, ownerOid: ALICE.oid }, QUESTION))).toBe(1);
    expect(await listed()).toEqual([conversationId]);
  });

  it("should announce a chat on a pod once when its first message is sent and a second follows", async () => {
    const { conversation, agentId } = await podChat();
    const send = () => directAsPerson(prisma, ALICE.oid, agentId, "hello");

    expect(await announcements(conversation.id, send)).toBe(1);
    expect(await announcements(conversation.id, send)).toBe(0);
  });
});
