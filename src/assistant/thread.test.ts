import { describe, expect, it } from "vitest";
import type { ThreadMessage } from "../messages/direct-thread.ts";
import { type ConversationItem, conversationItems, type TranscriptEntryView } from "../transcripts/conversation.ts";
import { activityLabel, progress, threadItems } from "./thread.ts";

let next = 0;

function person(body: string, at: string, delivery: ThreadMessage["delivery"] = "delivered"): ThreadMessage {
  next += 1;
  return {
    id: String(next),
    kind: "direct",
    title: null,
    body,
    topics: [],
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
    expect(threadItems(items, [{ product: "ccd", at: T(5) }])[1]).toMatchObject({ type: "product", label: "CCD (Core Case Data)" });
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
    const attachments = [{ id: "u1", name: "letter.pdf", bytes: 1024, media_type: "application/pdf" }];
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

  it("should be starting a session when the last message waits for an offline assistant", () => {
    const items = conversationItems([person("hi", T(1), "queued")], []);

    expect(state(items, "offline")).toEqual({ state: "waking", label: "Starting your assistant…" });
  });

  it("should be waiting for a free session when the pod has queued the conversation", () => {
    const items = conversationItems([person("hi", T(1), "queued")], []);

    expect(state(items, "offline", "queued")).toEqual({ state: "waking", label: "Waiting for a free assistant…" });
  });

  it("should name the latest tool since the message when the assistant is working on it", () => {
    const items = conversationItems(
      [person("hi", T(3))],
      [entry("tool_use", { id: "old", name: "Write", input: {} }, T(1)), entry("tool_use", { id: "t", name: "WebFetch", input: {} }, T(4))]
    );

    expect(state(items, "busy")).toEqual({ state: "working", label: "Looking things up" });
  });

  it("should be thinking when the assistant is busy with no tool since the message", () => {
    const items = conversationItems([person("hi", T(3))], [entry("tool_use", { id: "old", name: "Read", input: {} }, T(1))]);

    expect(state(items, "idle")).toEqual({ state: "working", label: "Thinking" });
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
  // contradict it. This is also what takes the stop control away the moment it has been used.
  it("should settle as soon as the person has stopped the answer, while the session still says busy", () => {
    const items = conversationItems([person("hi", T(1))], [entry("assistant", { text: "Working on it" }, T(2))]);

    expect(state(items, "busy").state).toBe("working");
    expect(stopped(items, "busy", [{ at: T(3) }])).toEqual({ state: "idle" });
  });

  it("should work again when the assistant carries on past a stop, so the thread does not claim it ended", () => {
    const items = conversationItems([person("hi", T(1))], [entry("assistant", { text: "Carrying on" }, T(5))]);

    expect(stopped(items, "busy", [{ at: T(3) }])).toEqual({ state: "working", label: "Thinking" });
  });

  it("should wait on a message the person sent after stopping the answer before it", () => {
    const items = conversationItems([person("first", T(1)), person("second", T(5))], []);

    expect(progress(items, threadItems(items, [], [{ at: T(3) }]), "offline", null)).toEqual({
      state: "waking",
      label: "Starting your assistant…"
    });
  });
});
