import { describe, expect, it } from "vitest";
import type { ThreadMessage } from "../messages/direct-thread.ts";
import type { QuestionView } from "../questions/views.ts";
import { type ConversationItem, conversationItems, type TranscriptEntryView } from "../transcripts/conversation.ts";
import {
  activityLabel,
  MAX_HELPERS,
  progress,
  progressAnnouncement,
  progressLabel,
  runningHelpers,
  sessionNotice,
  threadItems,
  WARMING_QUIPS
} from "./thread.ts";

let next = 0;

function person(body: string, at: string, delivery: ThreadMessage["delivery"] = "delivered"): ThreadMessage {
  next += 1;
  return {
    id: String(next),
    kind: "direct",
    title: null,
    body,
    topics: [],
    tagged_agents: [],
    in_reply_to: null,
    target_agent_id: "agent",
    created_at: at,
    author: { type: "user", agent_id: null, agent_name: null, owner_name: "Jas", owner_email: null },
    delivery
  };
}

function agentReply(body: string, at: string): ThreadMessage {
  return {
    ...person(body, at),
    target_agent_id: null,
    author: { type: "agent", agent_id: "agent", agent_name: "assistant", owner_name: "Jas", owner_email: null },
    delivery: null
  };
}

function entry(role: TranscriptEntryView["role"], content: TranscriptEntryView["content"], at: string, messageId: string | null = null): TranscriptEntryView {
  next += 1;
  return { id: String(next), key: `k${next}`, session_id: "s", role, content, truncated: false, redacted: false, message_id: messageId, occurred_at: at };
}

const T = (second: number) => `2026-10-21T10:00:${String(second).padStart(2, "0")}.000Z`;

/** A question the session asked, unanswered unless `answer` is given. */
function question(at: string, answer: { labels: string[]; text: string | null } | null = null): QuestionView {
  next += 1;
  return {
    id: `q-${next}`,
    agentId: "agent",
    askedAt: at,
    questions: [
      {
        question: "Red or blue?",
        header: "Colour",
        options: [
          { label: "Red", description: "warmer" },
          { label: "Blue", description: "cooler" }
        ],
        multiSelect: false
      }
    ],
    answer: answer === null ? null : { answers: [answer], at },
    // Still wanted while it is unanswered, which is what `progress` reads.
    offered: answer === null
  };
}

describe("threadItems", () => {
  it("should keep what the person and the assistant said and leave out tools and system lines when building the thread", () => {
    const asked = person("Draft a user story", T(1));
    const items = conversationItems(
      [asked],
      [
        entry("user", { text: "[agent-hub] Direct message #1 …" }, T(1), asked.id),
        entry("tool_use", { id: "t1", name: "Read", input: { file_path: "x" } }, T(2)),
        entry("tool_result", { tool_use_id: "t1", output: "…", is_error: false }, T(3)),
        entry("system", { text: "compacted" }, T(4)),
        entry("assistant", { text: "  As a court clerk…  " }, T(5)),
        entry("assistant", { text: "   " }, T(6))
      ]
    );

    expect(threadItems(items).map((item) => [item.type, "text" in item ? item.text : ""])).toEqual([
      ["user", "Draft a user story"],
      ["assistant", "As a court clerk…"]
    ]);
  });

  it("should show an agent's direct reply as the assistant's when it replied into the thread", () => {
    const items = conversationItems([agentReply("Here you are", T(2))], []);

    expect(threadItems(items)).toEqual([expect.objectContaining({ type: "assistant", text: "Here you are" })]);
  });

  it("should place each change of product in time, before a message at the same instant", () => {
    const items = conversationItems([person("first", T(1)), person("second", T(5))], []);

    expect(threadItems(items, [{ product: "ccd", at: T(5) }]).map((item) => item.type)).toEqual(["user", "product", "user"]);
    expect(threadItems(items, [{ product: "ccd", at: T(5) }])[1]).toMatchObject({ type: "product", label: "Core Case Data (CCD)" });
  });

  it("should mark where the person stopped an answer, after whatever the assistant had said by then", () => {
    const items = conversationItems([person("Draft it", T(1))], [entry("assistant", { text: "As a court clerk…" }, T(5))]);

    expect(threadItems(items, [], [{ at: T(5) }]).map((item) => item.type)).toEqual(["user", "assistant", "stopped"]);
    expect(threadItems(items, [], [{ at: T(5) }]).at(-1)).toEqual({ type: "stopped", key: `s${T(5)}`, at: T(5) });
  });

  it("should keep each stop in its own place when the person stopped the conversation more than once", () => {
    const items = conversationItems([person("first", T(1)), person("second", T(5))], []);

    expect(threadItems(items, [], [{ at: T(3) }, { at: T(7) }]).map((item) => item.type)).toEqual(["user", "stopped", "user", "stopped"]);
  });
});

describe("threadItems for a local chat", () => {
  /** A developer's own session: what they typed at it, what it ran, a compact summary, and what it answered. */
  function session() {
    return conversationItems(
      [],
      [
        entry("user", { text: "why did that delivery expire?" }, T(1)),
        entry("tool_use", { id: "t1", name: "Grep", input: { pattern: "expireDeliveries" } }, T(2)),
        entry("tool_result", { tool_use_id: "t1", output: "3 matches", is_error: false }, T(3)),
        entry("system", { text: "This session is being continued from…" }, T(4)),
        entry("assistant", { text: "It ran on the offline clock." }, T(5))
      ]
    );
  }

  it("should show what was typed at the laptop, which is the only record a local chat has of what it was asked", () => {
    const thread = threadItems(session(), [], [], true);

    expect(thread.map((item) => item.type)).toEqual(["user", "tool", "assistant"]);
    expect(thread[0]).toEqual({ type: "user", key: expect.any(String), at: T(1), text: "why did that delivery expire?", delivery: null, attachments: [] });
  });

  it("should leave out the compact summary a long session writes to itself, as a pod chat does", () => {
    expect(threadItems(session(), [], [], true).map((item) => "text" in item && item.text)).not.toContain("This session is being continued from…");
  });

  it("should leave a pod chat's thread exactly as it was, showing neither its tool calls nor any user entry", () => {
    expect(threadItems(session()).map((item) => item.type)).toEqual(["assistant"]);
  });

  it("should show a message sent from the composer once, and not again as the session's echo of it", () => {
    const sent = person("and now the other one", T(1));
    const items = conversationItems([sent], [entry("user", { text: "[agent-hub] Direct message #1\n\nand now the other one" }, T(2), sent.id)]);

    expect(threadItems(items, [], [], true).map((item) => [item.type, "text" in item ? item.text : ""])).toEqual([["user", "and now the other one"]]);
  });

  it("should leave a prompt whose words were redacted out rather than show an empty bubble", () => {
    const items = conversationItems([], [{ ...entry("user", { redacted: "an access token" }, T(1)), redacted: true }]);

    expect(threadItems(items, [], [], true)).toEqual([]);
  });
});

describe("threadItems tool rows", () => {
  function rows(entries: TranscriptEntryView[]) {
    return threadItems(conversationItems([], entries), [], [], true);
  }

  it("should say which tool ran and what it was given, and nothing about what came back", () => {
    const thread = rows([
      entry("tool_use", { id: "t1", name: "Bash", input: { command: "yarn test", description: "Run the unit suite" } }, T(1)),
      entry("tool_result", { tool_use_id: "t1", output: "4353 passed", is_error: false }, T(2))
    ]);

    expect(thread).toEqual([{ type: "tool", key: expect.any(String), at: T(1), name: "Bash", summary: "Run the unit suite", failed: false }]);
  });

  it("should mark the call the result that answered it said had failed", () => {
    const thread = rows([
      entry("tool_use", { id: "t1", name: "Bash", input: { command: "yarn lint" } }, T(1)),
      entry("tool_result", { tool_use_id: "t1", output: "1 error", is_error: true }, T(2))
    ]);

    expect(thread).toEqual([expect.objectContaining({ name: "Bash", summary: "yarn lint", failed: true })]);
  });

  it("should leave a call nothing has answered yet neutral, since it has not failed", () => {
    expect(rows([entry("tool_use", { id: "t1", name: "Read", input: { file_path: "src/x.ts" } }, T(1))])).toEqual([
      expect.objectContaining({ name: "Read", summary: "src/x.ts", failed: false })
    ]);
  });

  // A redacted call keeps `{id, name, redacted}`, so the row still says which tool ran; its input is what has gone.
  it("should still name the tool when the call itself was redacted", () => {
    const thread = rows([{ ...entry("tool_use", { id: "t1", name: "Bash", redacted: "an access token" }, T(1)), redacted: true }]);

    expect(thread).toEqual([expect.objectContaining({ name: "Bash", summary: "", failed: false })]);
  });

  it("should still show a row for a call that kept nothing but the pattern it matched", () => {
    const thread = rows([{ ...entry("tool_use", { redacted: "an access token" }, T(1)), redacted: true }]);

    expect(thread).toEqual([expect.objectContaining({ name: "Tool call", summary: "", failed: false })]);
  });

  // A redacted result keeps no `tool_use_id`, so nothing can say which call it answered. Reading it as this call's
  // would put "failed" against a call that may well have worked.
  it("should leave a call neutral when the result that could have answered it cannot be paired", () => {
    const thread = rows([
      entry("tool_use", { id: "t1", name: "Bash", input: { command: "git push" } }, T(1)),
      { ...entry("tool_result", { redacted: "an access token" }, T(2)), redacted: true }
    ]);

    expect(thread).toEqual([expect.objectContaining({ name: "Bash", failed: false })]);
  });

  it("should keep a call after the words it shares an instant with, which is the order the session wrote them", () => {
    const thread = rows([
      entry("assistant", { text: "Let me look at that file." }, T(1)),
      entry("tool_use", { id: "t1", name: "Read", input: { file_path: "src/x.ts" } }, T(1))
    ]);

    expect(thread.map((item) => item.type)).toEqual(["assistant", "tool"]);
  });
});

describe("threadItems questions", () => {
  it("should place a question the assistant asked in time, with its options for the card to show", () => {
    // Arrange
    const asked = question(T(3));

    // Act
    const items = threadItems(conversationItems([person("Draft it", T(1))], [entry("assistant", { text: "Before I do…" }, T(2))], [asked]));

    // Assert
    expect(items.map((item) => item.type)).toEqual(["user", "assistant", "question"]);
    expect(items.at(-1)).toEqual({ type: "question", key: `q${asked.id}`, at: T(3), question: asked });
  });

  it("should keep an answered question in its place, so the thread still shows what was asked", () => {
    // Act
    const items = threadItems(conversationItems([], [], [question(T(3), { labels: ["Red"], text: null })]));

    // Assert
    expect(items[0]).toMatchObject({ type: "question" });
    expect(items[0]?.type === "question" && items[0].question.answer?.answers).toEqual([{ labels: ["Red"], text: null }]);
  });
});

describe("activityLabel", () => {
  it.each([
    ["Read", "Reading"],
    ["WebSearch", "Looking things up"],
    ["Write", "Writing"],
    ["mcp__something", "Thinking"],
    [undefined, "Thinking"]
  ])("should describe %s as %s when the assistant is using it", (tool, label) => {
    expect(activityLabel(tool)).toBe(label);
  });
});

describe("threadItems attachments", () => {
  it("should carry the files on a message through to its user item", () => {
    // Arrange
    const attachments = [{ id: "u1", name: "letter.pdf", bytes: 1024, media_type: "application/pdf", available_until: "2026-10-21T12:00:00.000Z" }];
    const asked: ThreadMessage = { ...person("What does this say?", T(1)), attachments };

    // Act
    const items = threadItems(conversationItems([asked], []));

    // Assert
    expect(items).toEqual([{ type: "user", key: `m${asked.id}`, at: T(1), text: "What does this say?", delivery: "delivered", attachments }]);
  });

  it("should give a message with no attachments an empty list, so the view never sees a missing one", () => {
    // Act
    const items = threadItems(conversationItems([person("Hello", T(1))], []));

    // Assert
    expect(items[0]).toMatchObject({ type: "user", attachments: [] });
  });
});

describe("progress", () => {
  function state(items: ConversationItem[], status: "busy" | "idle" | "offline", session: "starting" | "live" | "queued" | null = null) {
    return progress(items, threadItems(items), status, session);
  }

  function stopped(items: ConversationItem[], status: "busy" | "idle" | "offline", stops: { at: string }[]) {
    return progress(items, threadItems(items, [], stops), status, null);
  }

  it("should be idle when the assistant has answered and is not busy", () => {
    const items = conversationItems([person("hi", T(1))], [entry("assistant", { text: "Hello" }, T(2))]);

    expect(state(items, "idle")).toEqual({ state: "idle" });
  });

  it("should be sending the message when it is still queued for a session that is already running", () => {
    const items = conversationItems([person("hi", T(1), "queued")], []);

    expect(state(items, "idle", "live")).toEqual({ state: "waking", label: "Sending your message…" });
  });

  it("should stop saying anything when the session goes idle with the answer unfinished, as a stopped one leaves it", () => {
    const items = conversationItems([person("hi", T(1))], [entry("tool_use", { id: "t", name: "Read", input: {} }, T(2))]);

    expect(state(items, "busy", "live").state).toBe("working");
    expect(state(items, "idle", "live")).toEqual({ state: "idle" });
  });

  it("should be starting a session when the last message waits for an offline assistant", () => {
    const items = conversationItems([person("hi", T(1), "queued")], []);

    expect(state(items, "offline")).toEqual({ state: "waking", label: "Starting your assistant…" });
  });

  it("should be waiting for a free session when the pod has queued the conversation", () => {
    const items = conversationItems([person("hi", T(1), "queued")], []);

    expect(state(items, "offline", "queued")).toEqual({ state: "waking", label: "Waiting for a free assistant…" });
  });

  // Neither of the two wordings above is true of a laptop: nothing is starting it and there is no queue it could be
  // in. The message is not lost — it waits on the stream the session opens when it comes back — so the line says
  // what is actually the case.
  it("should say the session is not connected when the chat is one on the person's own computer", () => {
    const items = conversationItems([person("hi", T(1), "queued")], []);

    expect(progress(items, threadItems(items), "offline", null, true)).toEqual({ state: "waking", label: "Waiting for your session to reconnect…" });
  });

  // `sessionState` is a pod supervisor's report and is null for every local chat, so the queued wording cannot be
  // reached there; this is what holds that true if one is ever written by something else.
  it("should say the same for a local chat however its session state reads", () => {
    const items = conversationItems([person("hi", T(1), "queued")], []);

    expect(progress(items, threadItems(items), "offline", "queued", true)).toMatchObject({ label: "Waiting for your session to reconnect…" });
  });

  it("should wait on a prompt typed at the laptop as it waits on a message, neither having been answered", () => {
    const items = conversationItems([], [entry("user", { text: "fix the test" }, T(1))]);

    expect(progress(items, threadItems(items, [], [], true), "offline", null, true)).toEqual({
      state: "waking",
      label: "Waiting for your session to reconnect…"
    });
  });

  // A local chat's thread ends on a tool row for most of every answer. Read as the last thing to have happened, it
  // would take the line away from the message that is in fact still waiting on a session nobody can reach.
  it("should still wait on the person's message when the thread ends on a tool call", () => {
    const items = conversationItems(
      [person("look into it", T(1), "queued")],
      [entry("tool_use", { id: "t1", name: "Grep", input: { pattern: "expireDeliveries" } }, T(2))]
    );
    const thread = threadItems(items, [], [], true);

    expect(thread.at(-1)?.type).toBe("tool");
    expect(progress(items, thread, "offline", null, true)).toEqual({ state: "waking", label: "Waiting for your session to reconnect…" });
  });

  it("should name the latest tool since the message when the assistant is working on it", () => {
    const items = conversationItems(
      [person("hi", T(3))],
      [entry("tool_use", { id: "old", name: "Write", input: {} }, T(1)), entry("tool_use", { id: "t", name: "WebFetch", input: {} }, T(4))]
    );

    expect(state(items, "busy")).toEqual({ state: "working", label: "Looking things up", helpers: 0 });
  });

  it("should be thinking when the assistant is busy with no tool since the message", () => {
    const items = conversationItems([person("hi", T(3))], [entry("tool_use", { id: "old", name: "Read", input: {} }, T(1))]);

    expect(state(items, "busy")).toEqual({ state: "working", label: "Thinking", helpers: 0 });
  });

  it("should keep working while the session says busy after an answer", () => {
    const items = conversationItems([person("hi", T(1))], [entry("assistant", { text: "One moment" }, T(2))]);

    expect(state(items, "busy").state).toBe("working");
  });

  it("should not wait on a message that expired undelivered", () => {
    const items = conversationItems([person("hi", T(1), "expired")], []);

    expect(state(items, "offline")).toEqual({ state: "idle" });
  });

  // The session's status is seconds behind the stop, and "Thinking…" under the line saying they stopped it would
  // contradict it. This is also what takes the stop control away the moment it has been used. The pod's interrupt
  // writing `idle` is what ends the work; this only covers the window before that is heard.
  it("should settle as soon as the person has stopped the answer, while the session still says busy", () => {
    const items = conversationItems([person("hi", T(1))], [entry("assistant", { text: "Working on it" }, T(2))]);

    expect(state(items, "busy").state).toBe("working");
    expect(stopped(items, "busy", [{ at: T(3) }])).toEqual({ state: "idle" });
  });

  it("should work again when the assistant carries on past a stop, so the thread does not claim it ended", () => {
    const items = conversationItems([person("hi", T(1))], [entry("assistant", { text: "Carrying on" }, T(5))]);

    expect(stopped(items, "busy", [{ at: T(3) }])).toEqual({ state: "working", label: "Thinking", helpers: 0 });
  });

  it("should wait on a message the person sent after stopping the answer before it", () => {
    const items = conversationItems([person("first", T(1)), person("second", T(5))], []);

    expect(progress(items, threadItems(items, [], [{ at: T(3) }]), "offline", null)).toEqual({
      state: "waking",
      label: "Starting your assistant…"
    });
  });

  // The session that asked was denied the tool and ended its turn, but its status reads `busy` for a few seconds
  // after. "Thinking…" under a card waiting for the person to choose says the opposite of what is true.
  it("should say nothing while a question is on screen unanswered, even with the session still busy", () => {
    const items = conversationItems([person("hi", T(1))], [entry("assistant", { text: "One thing first" }, T(2))], [question(T(3))]);

    expect(state(items, "busy")).toEqual({ state: "idle" });
  });

  it("should work again once the question has been answered", () => {
    const items = conversationItems([person("hi", T(1))], [], [question(T(3), { labels: ["Red"], text: null })]);

    expect(state(items, "busy")).toEqual({ state: "working", label: "Thinking", helpers: 0 });
  });

  // An unanswered card the person read past is not what they are being waited on for: they said something else, and
  // the assistant is working on that.
  it("should work on a message the person sent instead of answering the question", () => {
    const items = conversationItems([person("never mind, do this", T(5))], [], [question(T(3))]);

    expect(state(items, "busy")).toEqual({ state: "working", label: "Thinking", helpers: 0 });
  });

  // A card abandoned hours ago would otherwise go on claiming the assistant is waiting on the person for ever,
  // including while it is in fact working. `offered` is false once the window it was asked in has run out.
  it("should work again once the question is no longer being waited on", () => {
    const stale = { ...question(T(3)), offered: false };
    const items = conversationItems([person("hi", T(1))], [], [stale]);

    expect(state(items, "busy")).toEqual({ state: "working", label: "Thinking", helpers: 0 });
  });

  it("should count the subagents still running when the assistant has handed work out", () => {
    const items = conversationItems(
      [person("hi", T(1))],
      [
        entry("tool_use", { id: "a", name: "Task", input: {} }, T(2)),
        entry("tool_use", { id: "b", name: "Agent", input: {} }, T(3)),
        entry("tool_use", { id: "c", name: "Agent", input: {} }, T(4)),
        entry("tool_result", { tool_use_id: "b", output: "done", is_error: false }, T(5))
      ]
    );

    expect(state(items, "busy")).toEqual({ state: "working", label: "Working through it", helpers: 2 });
  });
});

describe("runningHelpers", () => {
  it("should count nothing when no subagent has been launched", () => {
    const items = conversationItems([person("hi", T(1))], [entry("tool_use", { id: "t", name: "Read", input: {} }, T(2))]);

    expect(runningHelpers(items, T(1))).toBe(0);
  });

  it("should leave out a subagent launched before the person's message, which belongs to the answer before it", () => {
    const items = conversationItems(
      [person("hi", T(5))],
      [entry("tool_use", { id: "old", name: "Task", input: {} }, T(1)), entry("tool_use", { id: "new", name: "Task", input: {} }, T(6))]
    );

    expect(runningHelpers(items, T(5))).toBe(1);
  });

  it("should count nothing when a result was redacted, since the call it answers cannot be told", () => {
    const items = conversationItems(
      [person("hi", T(1))],
      [
        entry("tool_use", { id: "a", name: "Task", input: {} }, T(2)),
        entry("tool_use", { id: "b", name: "Task", input: {} }, T(3)),
        { ...entry("tool_result", { redacted: "an access token" }, T(4)), redacted: true }
      ]
    );

    expect(runningHelpers(items, T(1))).toBe(0);
  });

  it("should still pair a subagent whose call was redacted, which keeps the id it is answered against", () => {
    const items = conversationItems(
      [person("hi", T(1))],
      [
        { ...entry("tool_use", { id: "a", name: "Task", redacted: "an access token" }, T(2)), redacted: true },
        entry("tool_result", { tool_use_id: "a", output: "done", is_error: false }, T(3))
      ]
    );

    expect(runningHelpers(items, T(1))).toBe(0);
  });

  it("should cap the count at the most subagents Claude Code will run at once", () => {
    const launches = Array.from({ length: MAX_HELPERS + 5 }, (_unused, n) => entry("tool_use", { id: `a${n}`, name: "Agent", input: {} }, T(2)));
    const items = conversationItems([person("hi", T(1))], launches);

    expect(runningHelpers(items, T(1))).toBe(MAX_HELPERS);
  });
});

describe("sessionNotice", () => {
  const IDLE = { state: "idle" } as const;

  it("should say nothing while a session is live, which will answer whatever is sent to it", () => {
    expect(sessionNotice("live", "offline", IDLE)).toBeNull();
  });

  it("should offer the warming quips while the pod is starting a session", () => {
    const notice = sessionNotice("starting", "offline", IDLE);

    expect(notice).toEqual({ state: "starting", words: WARMING_QUIPS, announcement: "Starting your assistant" });
    expect(notice?.words.length).toBeGreaterThan(1);
  });

  // Every quip has to carry the one fact on its own: it is the only line on the screen, and somebody reading one of
  // them and nothing else must not come away thinking the assistant is there.
  it.each(WARMING_QUIPS)("should still say an assistant is coming in %j", (quip) => {
    expect(quip).toMatch(/assistant/i);
    expect(quip).toMatch(/start|warm|wak|kettle|lur/i);
  });

  // A real wait with a real cause — the pod is at its cap and another chat has to give up its session first. A joke
  // over it would hide both, so this is the same plain wording the line under the thread uses.
  it("should say plainly that the chat is waiting its turn when the pod has queued it", () => {
    expect(sessionNotice("queued", "offline", IDLE)).toEqual({
      state: "queued",
      words: ["Waiting for a free assistant…"],
      announcement: "Waiting for a free assistant"
    });
  });

  it("should say what will start a session when nothing has asked for one", () => {
    expect(sessionNotice(null, "offline", IDLE)).toEqual({
      state: "unstarted",
      words: ["Your assistant starts when you send a message."],
      announcement: "Your assistant starts when you send a message."
    });
  });

  // No pod, no supervisor, and `localOfflineNote` already says the one thing there is to say about a laptop that is
  // away. This is what keeps the two from both being on the screen.
  it.each(["starting", "queued", "live", null] as const)("should say nothing at all on a local chat reading %j", (session) => {
    expect(sessionNotice(session, "offline", IDLE, true)).toBeNull();
  });

  // Whatever a report yet to land says, an agent answering the hub has a session behind it — and is also the agent
  // the composer's wake on focus leaves alone, so this is the same bound the wake itself is gated on.
  it.each(["idle", "busy"] as const)("should say nothing about a session when the agent is %j", (agentStatus) => {
    expect(sessionNotice(null, agentStatus, IDLE)).toBeNull();
  });

  // The line under the thread words the wait once the person has sent something. Both would be the same wait said
  // twice, directly above and below each other.
  it.each([[{ state: "waking", label: "Starting your assistant…" } as const], [{ state: "working", label: "Reading", helpers: 0 } as const]])(
    "should leave the wait to the progress line when it is already saying %j",
    (doing) => {
      expect(sessionNotice("starting", "offline", doing)).toBeNull();
    }
  );
});

describe("progressLabel and progressAnnouncement", () => {
  it.each([
    [{ state: "idle" } as const, "", ""],
    [{ state: "waking", label: "Starting your assistant…" } as const, "Starting your assistant…", "Starting your assistant"],
    [
      { state: "waking", label: "Waiting for your session to reconnect…" } as const,
      "Waiting for your session to reconnect…",
      "Waiting for your session to reconnect"
    ],
    [{ state: "working", label: "Reading", helpers: 0 } as const, "Reading", "Working on your answer"],
    [
      { state: "working", label: "Working through it", helpers: 1 } as const,
      "Working through it · 1 helper running",
      "Working on your answer, with 1 helper running"
    ],
    [
      { state: "working", label: "Working through it", helpers: 3 } as const,
      "Working through it · 3 helpers running",
      "Working on your answer, with 3 helpers running"
    ]
  ])("should show %j as its own line and announce only what has settled", (doing, shown, announced) => {
    expect(progressLabel(doing)).toBe(shown);
    expect(progressAnnouncement(doing)).toBe(announced);
  });
});
