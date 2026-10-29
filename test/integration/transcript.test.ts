import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { findAgent, listMessageableAgents, registerAgent } from "../../src/agents/store.ts";
import { visibleAgents } from "../../src/agents/views.ts";
import { POST as upload } from "../../src/app/api/agent/[agentId]/transcript/route.ts";
import { GET as conversation } from "../../src/app/api/ui/agents/[id]/transcript/route.ts";
import { GET as stream } from "../../src/app/api/ui/stream/route.ts";
import { directAsAgent } from "../../src/messages/send.ts";
import { createDirect, createPost } from "../../src/messages/store.ts";
import { realtime } from "../../src/realtime/process.ts";
import type { PrismaClient } from "../../src/store/prisma.ts";
import type { ConversationPage } from "../../src/transcripts/conversation.ts";
import { MAX_ENTRY_CONTENT_BYTES } from "../../src/transcripts/limits.ts";
import { startTranscriptSweep, sweepTranscripts } from "../../src/transcripts/sweep.ts";
import { CONVERSATION_PAGE_SIZE } from "../../src/transcripts/views.ts";
import { connect, insertAgent, insertUser, type Person, person, prisma, resetDatabase } from "./database.ts";
import { call, jsonOf } from "./routes.ts";
import { frames } from "./sse-reader.ts";
import { until } from "./waits.ts";

const ALICE = person("alice");
const BOB = person("bob");
const CAROL = person("carol");

let alicesAgent: string;
let carolsAgent: string;

const DAY_MS = 24 * 60 * 60 * 1000;

function at(offsetMs: number): string {
  return new Date(Date.parse("2026-10-02T09:00:00.000Z") + offsetMs).toISOString();
}

function entry(key: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { key, role: "assistant", content: { text: `entry ${key}` }, occurred_at: at(0), ...overrides };
}

async function send(as: Person, agentId: string, body: unknown): Promise<Response> {
  return await call(upload, { as, path: `/api/agent/${agentId}/transcript`, method: "POST", params: { agentId }, body });
}

async function accepted(agentId: string, entries: unknown[], sessionId = "session-1"): Promise<number> {
  const response = await send(ALICE, agentId, { session_id: sessionId, entries });
  expect(response.status).toBe(200);
  return (await jsonOf<{ accepted: number }>(response)).accepted;
}

function uiRequest(as: string, path: string, signal?: AbortSignal): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, { headers: { cookie: `ah_dev_persona=${as}` }, ...(signal ? { signal } : {}) });
}

async function read(as: string, agentId: string, query = ""): Promise<Response> {
  return await conversation(uiRequest(as, `/api/ui/agents/${agentId}/transcript${query}`), { params: Promise.resolve({ id: agentId }) });
}

async function page(as: string, agentId: string, query = ""): Promise<ConversationPage> {
  const response = await read(as, agentId, query);
  expect(response.status).toBe(200);
  return await jsonOf<ConversationPage>(response);
}

beforeAll(async () => {
  await realtime().listener.ready();
});

beforeEach(async () => {
  await resetDatabase();
  alicesAgent = await insertAgent(ALICE, "alices-agent");
  carolsAgent = await insertAgent(CAROL, "carols-agent");
  await insertUser(BOB);
});

afterAll(async () => {
  await realtime().listener.stop();
  await prisma.$disconnect();
});

describe("POST /api/agent/{agent_id}/transcript", () => {
  it("should store each entry once and count only the new ones when a batch is sent again", async () => {
    expect(await accepted(alicesAgent, [entry("s1:1"), entry("s1:2", { role: "user", content: { text: "hi" } })])).toBe(2);
    expect(await accepted(alicesAgent, [entry("s1:2"), entry("s1:3"), entry("s1:3")])).toBe(1);

    const rows = await prisma.transcriptEntry.findMany({ orderBy: { id: "asc" } });
    expect(rows.map((row) => [row.entryKey, row.role, row.content, row.sessionId])).toEqual([
      ["s1:1", "assistant", { text: "entry s1:1" }, "session-1"],
      ["s1:2", "user", { text: "hi" }, "session-1"],
      ["s1:3", "assistant", { text: "entry s1:3" }, "session-1"]
    ]);
  });

  it("should keep an entry key per agent when two agents send the same one", async () => {
    expect(await accepted(alicesAgent, [entry("same")])).toBe(1);
    const response = await send(CAROL, carolsAgent, { session_id: "s", entries: [entry("same")] });

    expect(await jsonOf(response)).toEqual({ accepted: 1 });
  });

  it("should store the flags, the time and the content of every role when they are sent", async () => {
    await accepted(alicesAgent, [
      entry("a", { role: "tool_use", content: { id: "t1", name: "Bash", input: { command: "ls" } }, occurred_at: "2026-10-02T10:00:00.5+01:00" }),
      entry("b", { role: "tool_result", content: { tool_use_id: "t1", output: "x".repeat(10), is_error: true }, truncated: true }),
      entry("c", { role: "tool_use", redacted: true, content: { id: "t2", name: "Read", redacted: "AKIA[0-9A-Z]{16}" } })
    ]);

    const rows = await prisma.transcriptEntry.findMany({ orderBy: { id: "asc" } });
    expect(rows.map((row) => [row.content, row.truncated, row.redacted, row.occurredAt.toISOString()])).toEqual([
      [{ id: "t1", name: "Bash", input: { command: "ls" } }, false, false, "2026-10-02T09:00:00.500Z"],
      [{ tool_use_id: "t1", output: "xxxxxxxxxx", is_error: true }, true, false, at(0)],
      [{ id: "t2", name: "Read", redacted: "AKIA[0-9A-Z]{16}" }, false, true, at(0)]
    ]);
  });

  it("should link an entry only to a direct message sent to this agent when it names a message", async () => {
    const toAlice = await createDirect(prisma, { author: { oid: BOB.oid, agentId: null }, targetAgentId: alicesAgent, inReplyTo: null, body: "to alice" });
    const toCarol = await createDirect(prisma, {
      author: { oid: ALICE.oid, agentId: alicesAgent },
      targetAgentId: carolsAgent,
      inReplyTo: null,
      body: "to carol"
    });
    const post = await createPost(prisma, {
      author: { oid: ALICE.oid, agentId: alicesAgent },
      topics: ["pcs-api"],
      title: null,
      body: "a post",
      inReplyTo: null
    });

    expect(
      await accepted(alicesAgent, [
        entry("mine", { role: "user", message_id: toAlice.id }),
        entry("theirs", { role: "user", message_id: toCarol.id }),
        entry("post", { role: "user", message_id: post.id }),
        entry("missing", { role: "user", message_id: "999999" }),
        entry("none", { role: "user", message_id: null })
      ])
    ).toBe(5);

    const rows = await prisma.transcriptEntry.findMany({ orderBy: { id: "asc" } });
    expect(rows.map((row) => [row.entryKey, row.messageId?.toString() ?? null])).toEqual([
      ["mine", toAlice.id],
      ["theirs", null],
      ["post", null],
      ["missing", null],
      ["none", null]
    ]);
  });

  it.each<[string, unknown, RegExp]>([
    [
      "an entry over the size limit",
      { session_id: "s", entries: [entry("ok"), entry("big", { content: { text: "a".repeat(MAX_ENTRY_CONTENT_BYTES) } })] },
      /^entries\.1\.content: is larger than/
    ],
    ["an invalid entry among valid ones", { session_id: "s", entries: [entry("ok"), entry("bad", { role: "tool_use" })] }, /^entries\.1\.content: must be/],
    ["no entries", { session_id: "s", entries: [] }, /^entries:/],
    ["no session id", { entries: [entry("ok")] }, /^session_id:/]
  ])("should refuse the whole batch with 400 when it holds %s", async (_label, body, error) => {
    const response = await send(ALICE, alicesAgent, body);

    expect(response.status).toBe(400);
    expect((await jsonOf<{ error: string }>(response)).error).toMatch(error);
    expect(await prisma.transcriptEntry.count()).toBe(0);
  });

  it("should refuse an upload to someone else's agent with 403 and an unknown agent with 404", async () => {
    expect((await send(ALICE, carolsAgent, { session_id: "s", entries: [entry("x")] })).status).toBe(403);
    expect((await send(ALICE, "00000000-0000-0000-0000-000000000000", { session_id: "s", entries: [entry("x")] })).status).toBe(404);
  });

  it("should refuse a body over the request cap with 413", async () => {
    const response = await call(upload, {
      as: ALICE,
      path: `/api/agent/${alicesAgent}/transcript`,
      method: "POST",
      params: { agentId: alicesAgent },
      body: { session_id: "s", entries: [entry("x", { content: { text: "a".repeat(300 * 1024) } })] }
    });

    expect(response.status).toBe(413);
  });

  it("should refuse content the API never accepts when it is written past the API", async () => {
    await expect(
      prisma.transcriptEntry.create({
        data: { agentId: alicesAgent, sessionId: "s", entryKey: "raw", role: "assistant", content: { text: "a".repeat(40_000) }, occurredAt: new Date() }
      })
    ).rejects.toThrow(/transcript_entry_content_size/);
  });
});

describe("GET /api/ui/agents/{id}/transcript", () => {
  // A transcript is its owner's, and an agent that is not the caller's is reported as not existing rather than
  // as forbidden: the same answer a malformed id gets, so nothing here confirms an id.
  it.each([
    ["the owner", "alice", 200],
    ["a colleague with no agents, as missing", "bob", 404],
    ["another owner, as missing", "carol", 404]
  ])("should answer %s", async (_label, as, status) => {
    await accepted(alicesAgent, [entry("1")]);

    const response = await read(as, alicesAgent);

    expect(response.status).toBe(status);
  });

  it("should refuse an unknown or malformed agent id as missing, and a malformed cursor with 400", async () => {
    expect((await read("alice", "00000000-0000-0000-0000-000000000000")).status).toBe(404);
    expect((await read("alice", "not-an-id")).status).toBe(404);
    expect((await read("alice", alicesAgent, "?before=x")).status).toBe(400);
    expect((await read("alice", alicesAgent, "?before=1&after=2")).status).toBe(400);
  });

  it("should merge the thread with the transcript and give the newest id when read with no cursor", async () => {
    const direct = await createDirect(prisma, { author: { oid: BOB.oid, agentId: null }, targetAgentId: alicesAgent, inReplyTo: null, body: "hello" });
    await accepted(alicesAgent, [entry("a", { role: "user", message_id: direct.id, occurred_at: at(2000) }), entry("b", { occurred_at: at(1000) })]);

    // Read as the owner: a transcript is its owner's alone, so Bob authoring the direct does not let him read it.
    const result = await page("alice", alicesAgent);

    expect(result.messages.map((message) => message.body)).toEqual(["hello"]);
    expect(result.entries.map((item) => [item.key, item.message_id])).toEqual([
      ["b", null],
      ["a", direct.id]
    ]);
    expect(result.olderBefore).toBeNull();
    expect(result.lastId).toBe(result.entries.find((item) => item.key === "b")!.id);
  });

  it("should page backwards through the entries and the messages between them when read with before", async () => {
    const total = CONVERSATION_PAGE_SIZE + 5;
    const entries = Array.from({ length: total }, (_, index) => entry(`k${index}`, { occurred_at: at(index * 1000) }));
    for (let start = 0; start < total; start += 100) {
      await accepted(alicesAgent, entries.slice(start, start + 100));
    }
    const early = await createDirect(prisma, { author: { oid: BOB.oid, agentId: null }, targetAgentId: alicesAgent, inReplyTo: null, body: "early" });
    await prisma.message.update({ where: { id: BigInt(early.id) }, data: { createdAt: new Date(at(1500)) } });
    const late = await createDirect(prisma, { author: { oid: BOB.oid, agentId: null }, targetAgentId: alicesAgent, inReplyTo: null, body: "late" });
    await prisma.message.update({ where: { id: BigInt(late.id) }, data: { createdAt: new Date(at(50_500)) } });

    const newest = await page("alice", alicesAgent);
    expect(newest.entries).toHaveLength(CONVERSATION_PAGE_SIZE);
    expect(newest.entries[0]!.key).toBe("k5");
    expect(newest.messages.map((message) => message.body)).toEqual(["late"]);
    expect(newest.olderBefore).toBe(newest.entries[0]!.id);

    const older = await page("alice", alicesAgent, `?before=${newest.olderBefore}`);
    expect(older.entries.map((item) => item.key)).toEqual(["k0", "k1", "k2", "k3", "k4"]);
    expect(older.messages.map((message) => message.body)).toEqual(["early"]);
    expect(older.olderBefore).toBeNull();
    expect(older.lastId).toBeNull();
  });

  it("should give the entries stored after an id, whenever they occurred, when read with after", async () => {
    await accepted(alicesAgent, [entry("a", { occurred_at: at(5000) })]);
    const first = await page("alice", alicesAgent);
    await accepted(alicesAgent, [entry("late-arrival", { occurred_at: at(1000) }), entry("b", { occurred_at: at(6000) })]);

    const topUp = await page("alice", alicesAgent, `?after=${first.lastId}`);

    expect(topUp.entries.map((item) => item.key)).toEqual(["late-arrival", "b"]);
    expect(topUp.messages).toEqual([]);
    expect(topUp.more).toBe(false);
    expect(BigInt(topUp.lastId!)).toBeGreaterThan(BigInt(first.lastId!));
    expect((await page("alice", alicesAgent, `?after=${topUp.lastId}`)).entries).toEqual([]);
  });

  it("should give an empty page when the entry it pages before has gone", async () => {
    expect(await page("alice", alicesAgent, "?before=12345")).toEqual({ messages: [], entries: [], olderBefore: null, lastId: null, more: false });
  });
});

/**
 * A conversation of a session on somebody's own laptop, which has no pod. Its agent is one of the owner's ordinary
 * sessions: on their roster, in their messageable list, and taggable by anyone in a post. A pod conversation's
 * agent, the HMCTS Assistant, is in none of those places — not even for its owner, who reaches that chat through
 * the Assistant — and is here as the contrast.
 *
 * The local one is a real registration, so these read the rows the hub itself writes.
 */
describe("an agent in a conversation", () => {
  let local: string;
  let pod: string;

  beforeEach(async () => {
    local = (
      await registerAgent(
        prisma,
        { oid: ALICE.oid, tid: "dev", name: ALICE.name, email: ALICE.email },
        { sessionId: "alices-laptop", name: "alices-local-chat", cwd: null, repo: null, branch: null, host: null }
      )
    ).id;
    pod = await insertAgent(ALICE, "alices-assistant");
    const assistant = await prisma.virtualAgent.create({ data: { ownerOid: ALICE.oid, name: "assistant", modelRoute: "gateway" }, select: { id: true } });
    const chat = await prisma.assistantConversation.create({ data: { ownerOid: ALICE.oid, virtualAgentId: assistant.id, agentId: pod }, select: { id: true } });
    await prisma.agent.update({ where: { id: pod }, data: { assistantConversationId: chat.id, virtualAgentId: assistant.id } });
  });

  it("should keep a local session on its owner's roster and leave the pod conversation's agent off it", async () => {
    const mine = await visibleAgents(prisma, ALICE.oid);

    expect(mine.map((card) => card.id)).toContain(local);
    expect(mine.map((card) => card.id)).not.toContain(pod);
    // Neither is anyone else's to see, whichever kind it is.
    expect((await visibleAgents(prisma, BOB.oid)).map((card) => card.id)).toEqual([]);
  });

  // A direct message is between one person's own sessions, so the sender here is another agent of Alice's. The pod
  // conversation's agent is off the list and unreachable by name even for her, which is the exclusion in
  // `agentsMessageableBy`; by id it is still one of her own sessions, as it always was, and that is what the
  // Assistant's own composer sends through.
  it("should let the owner's own agent message a local session by name and by id, and not name the pod conversation's", async () => {
    const alicesOther = await insertAgent(ALICE, "alices-other");
    const sender = (await findAgent(prisma, alicesOther))!;
    const bobsAgent = await insertAgent(BOB, "bobs-agent");
    const colleague = (await findAgent(prisma, bobsAgent))!;

    expect((await listMessageableAgents(prisma, ALICE.oid)).map((listed) => listed.id)).toEqual(expect.arrayContaining([local]));
    expect((await listMessageableAgents(prisma, ALICE.oid)).map((listed) => listed.id)).not.toContain(pod);
    expect((await directAsAgent(prisma, sender, { toAgent: "alices-local-chat", body: "still reachable" })).target_agent_id).toBe(local);
    expect((await directAsAgent(prisma, sender, { toAgent: local, body: "and by id" })).target_agent_id).toBe(local);
    await expect(directAsAgent(prisma, sender, { toAgent: "alices-assistant", body: "nor by name" })).rejects.toThrow(/no agent you may message/);
    // And a colleague's agent reaches neither, by name or by id: it posts and tags the local one instead.
    await expect(directAsAgent(prisma, colleague, { toAgent: local, body: "not yours" })).rejects.toThrow(/tag that agent/);
    await expect(directAsAgent(prisma, colleague, { toAgent: "alices-local-chat", body: "nor by name" })).rejects.toThrow(/no agent you may message/);
  });

  it("should report both kinds of conversation agent as missing to a colleague asking for the transcript", async () => {
    await accepted(local, [entry("1")]);

    expect((await read("alice", local)).status).toBe(200);
    expect((await read("bob", local)).status).toBe(404);
    expect((await read("bob", pod)).status).toBe(404);
  });

  it("should send a transcript event for a local session to its owner, and open no stream at all for a colleague", async () => {
    const refused = await stream(uiRequest("bob", `/api/ui/stream?agent=${local}`, new AbortController().signal));
    expect(refused.status).toBe(404);

    const watchers = await Promise.all(
      ["alice"].map(async (as) => {
        const controller = new AbortController();
        const response = await stream(uiRequest(as, `/api/ui/stream?agent=${local}`, controller.signal));
        expect(response.status).toBe(200);
        const reader = frames(response);
        await reader.drain(100);
        return { controller, reader };
      })
    );
    const [alice] = watchers;

    try {
      await accepted(local, [entry("1")]);

      expect(await alice!.reader.named("transcript", 1)).toHaveLength(1);
    } finally {
      for (const { controller, reader } of watchers) {
        controller.abort();
        await reader.cancel();
      }
    }
  });
});

describe("transcript events on the UI stream", () => {
  const open: { controller: AbortController; reader: ReturnType<typeof frames> }[] = [];

  async function watch(as: string, query: string) {
    const controller = new AbortController();
    const response = await stream(uiRequest(as, `/api/ui/stream?${query}`, controller.signal));
    expect(response.status).toBe(200);
    const reader = frames(response);
    open.push({ controller, reader });
    await reader.drain(100);
    return reader;
  }

  afterEach(async () => {
    for (const { controller, reader } of open.splice(0)) {
      controller.abort();
      await reader.cancel();
    }
  });

  it("should tell each owner about their own agent, once per batch, and nothing for a batch already stored", async () => {
    const alice = await watch("alice", `agent=${alicesAgent}`);
    const carol = await watch("carol", `agent=${carolsAgent}`);

    await accepted(alicesAgent, [entry("1"), entry("2")]);
    const [frame] = await alice.named("transcript", 1);
    const stored = await prisma.transcriptEntry.findMany({ orderBy: { id: "asc" } });
    expect(JSON.parse(frame!.data!)).toEqual({ agent_id: alicesAgent, last_id: stored.at(-1)!.id.toString() });

    await accepted(alicesAgent, [entry("1")]);
    await alice.drain(300);
    await carol.drain(100);

    expect(alice.received.filter((received) => received.event === "transcript")).toHaveLength(1);
    expect(carol.received.filter((received) => received.event === "transcript")).toEqual([]);
  });
});

/** Backdates when the hub stored an entry, which is what retention measures against. */
async function storedAt(entryKey: string, at: number): Promise<void> {
  await prisma.transcriptEntry.updateMany({ where: { entryKey }, data: { createdAt: new Date(at) } });
}

describe("sweepTranscripts", () => {
  it("should delete entries past retention and the oldest beyond an agent's cap, and keep the rest", async () => {
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    await accepted(alicesAgent, [
      entry("old", { occurred_at: iso(now - 31 * DAY_MS) }),
      entry("a1", { occurred_at: iso(now - 3000) }),
      entry("a2", { occurred_at: iso(now - 2000) }),
      entry("a3", { occurred_at: iso(now - 1000) })
    ]);
    const response = await send(CAROL, carolsAgent, { session_id: "s", entries: [entry("c1", { occurred_at: iso(now - 1000) })] });
    expect(response.status).toBe(200);
    // Retention goes by when the hub stored an entry, so the one that is past it has to have been stored back then.
    await storedAt("old", now - 31 * DAY_MS);

    expect(await sweepTranscripts(prisma, { maxPerAgent: 2 })).toEqual({ expired: 1, trimmed: 1 });

    const kept = await prisma.transcriptEntry.findMany({ orderBy: { id: "asc" } });
    expect(kept.map((row) => row.entryKey)).toEqual(["a2", "a3", "c1"]);
    expect(await sweepTranscripts(prisma, { maxPerAgent: 2 })).toEqual({ expired: 0, trimmed: 0 });
  });

  it("should delete an entry stamped in the future once the hub has held it for the retention period", async () => {
    const now = Date.now();
    await accepted(alicesAgent, [entry("ahead", { occurred_at: new Date(now + 60 * DAY_MS).toISOString() })]);
    // Nothing bounds occurred_at above, and the cap is not applied to an agent nothing is arriving for, so retention
    // measured against this entry's own timestamp would never have reached it and nothing else would have.
    await storedAt("ahead", now - 31 * DAY_MS);

    expect(await sweepTranscripts(prisma)).toEqual({ expired: 1, trimmed: 0 });
    expect(await prisma.transcriptEntry.count()).toBe(0);
  });

  it("should apply the cap only to an agent written to lately, and again as soon as it is", async () => {
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    await accepted(alicesAgent, [
      entry("q1", { occurred_at: iso(now - 3000) }),
      entry("q2", { occurred_at: iso(now - 2000) }),
      entry("q3", { occurred_at: iso(now - 1000) })
    ]);
    // Nothing stored for it since the day before yesterday, so nothing is still arriving and the cap is not applied.
    // What decides is when the hub stored an entry, never a timestamp the entry carries or a heartbeat beside it:
    // these three say they occurred seconds ago, and the agent's last heartbeat is now.
    for (const key of ["q1", "q2", "q3"]) {
      await storedAt(key, now - 2 * DAY_MS);
    }

    expect(await sweepTranscripts(prisma, { maxPerAgent: 2 })).toEqual({ expired: 0, trimmed: 0 });
    expect(await prisma.transcriptEntry.count()).toBe(3);

    await accepted(alicesAgent, [entry("q4", { occurred_at: iso(now) })]);

    expect(await sweepTranscripts(prisma, { maxPerAgent: 2 })).toEqual({ expired: 0, trimmed: 2 });
    const kept = await prisma.transcriptEntry.findMany({ orderBy: { id: "asc" } });
    expect(kept.map((row) => row.entryKey)).toEqual(["q3", "q4"]);
  });

  it("should stand down while another pod holds the transcript sweep lock", async () => {
    const other = await connect();
    try {
      await other.query("BEGIN");
      await other.query("SELECT pg_advisory_xact_lock($1)", [0x74726e73_73776570n.toString()]);

      expect(await sweepTranscripts(prisma)).toBeUndefined();

      await other.query("COMMIT");
      expect(await sweepTranscripts(prisma)).toEqual({ expired: 0, trimmed: 0 });
    } finally {
      await other.end();
    }
  });

  it("should delete an agent's transcript with the agent when the agent is deleted", async () => {
    await accepted(alicesAgent, [entry("1")]);

    await prisma.agent.delete({ where: { id: alicesAgent } });

    expect(await prisma.transcriptEntry.count()).toBe(0);
  });
});

describe("startTranscriptSweep", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should log what a tick deleted, and nothing for a tick that deleted nothing", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await accepted(alicesAgent, [entry("old", { occurred_at: new Date(Date.now() - 31 * DAY_MS).toISOString() })]);
    await storedAt("old", Date.now() - 31 * DAY_MS);
    const transaction = vi.spyOn(prisma, "$transaction");
    const sweeper = startTranscriptSweep(prisma, 10);
    try {
      await until(() => info.mock.calls.length > 0);
      const calls = transaction.mock.calls.length;
      await until(() => transaction.mock.calls.length >= calls + 2);
    } finally {
      await sweeper.stop();
    }

    expect(info.mock.calls).toEqual([["transcript sweep: 1 entries past retention and 0 over the per-agent cap deleted"]]);
  });

  it("should warn when a tick fails, and skip ticks while one is still running", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failures: unknown[] = [new Error("database gone"), "not an error"];
    let started = 0;
    const failing = {
      $transaction: () => {
        const failure = failures[started++ % failures.length];
        return new Promise((_, reject) => setTimeout(() => reject(failure), 50));
      }
    } as unknown as PrismaClient;
    const sweeper = startTranscriptSweep(failing, 5);
    try {
      await until(() => warn.mock.calls.length >= 2);
    } finally {
      await sweeper.stop();
    }

    expect(warn.mock.calls.slice(0, 2)).toEqual([["the transcript sweep failed: database gone"], ["the transcript sweep failed: not an error"]]);
    expect(started).toBeLessThanOrEqual(warn.mock.calls.length + 1);
  });
});
