import { describe, expect, it } from "vitest";
import type { ThreadMessage } from "../messages/direct-thread.ts";
import { conversationItems, mergeEntries, newerId, oneLine, type TranscriptEntryView, toolSummary } from "./conversation.ts";

function message(id: string, createdAt: string): ThreadMessage {
  return {
    id,
    kind: "direct",
    title: null,
    body: `message ${id}`,
    topics: [],
    in_reply_to: null,
    target_agent_id: "agent-1",
    created_at: createdAt,
    author: { type: "user", agent_id: null, agent_name: null, owner_name: "Alice", owner_email: null },
    delivery: "delivered"
  };
}

function entry(id: string, occurredAt: string, overrides: Partial<TranscriptEntryView> = {}): TranscriptEntryView {
  return {
    id,
    key: `k${id}`,
    session_id: "s",
    role: "assistant",
    content: { text: `entry ${id}` },
    truncated: false,
    redacted: false,
    message_id: null,
    occurred_at: occurredAt,
    ...overrides
  };
}

const T1 = "2026-10-02T09:00:01.000Z";
const T2 = "2026-10-02T09:00:02.000Z";
const T3 = "2026-10-02T09:00:03.000Z";

describe("conversationItems", () => {
  it("should interleave messages and entries by time when both are present", () => {
    const items = conversationItems([message("10", T2)], [entry("2", T3), entry("1", T1)]);

    expect(items.map((item) => item.key)).toEqual(["t1", "m10", "t2"]);
  });

  it("should put a message before an entry, and order each kind by id, when they share an instant", () => {
    const items = conversationItems([message("10", T1), message("9", T1)], [entry("3", T1), entry("20", T1)]);

    expect(items.map((item) => item.key)).toEqual(["m9", "m10", "t3", "t20"]);
  });

  it("should fold a user entry into the message it records when that message is shown", () => {
    const items = conversationItems([message("10", T2)], [entry("1", T2, { role: "user", message_id: "10" }), entry("2", T3)]);

    expect(items.map((item) => item.key)).toEqual(["m10", "t2"]);
  });

  it("should keep a user entry when the message it records is not shown or it is not a user entry", () => {
    const items = conversationItems(
      [message("10", T1)],
      [entry("1", T2, { role: "user", message_id: "11" }), entry("2", T3, { role: "assistant", message_id: "10" })]
    );

    expect(items.map((item) => item.key)).toEqual(["m10", "t1", "t2"]);
  });

  it("should give each item its time when it is built", () => {
    const [first, second] = conversationItems([message("10", T2)], [entry("1", T1)]);

    expect([first?.at, second?.at]).toEqual([T1, T2]);
  });
});

describe("mergeEntries", () => {
  it("should keep each entry once, in time order, when pages overlap", () => {
    const merged = mergeEntries([entry("2", T2), entry("3", T3)], [entry("1", T1), entry("2", T2), entry("12", T2)]);

    expect(merged.map((item) => item.id)).toEqual(["1", "2", "12", "3"]);
  });
});

describe("newerId", () => {
  it.each<[string | null, string | null, string | null]>([
    [null, null, null],
    ["5", null, "5"],
    [null, "5", "5"],
    ["9", "10", "10"],
    ["10", "9", "10"],
    ["7", "7", "7"]
  ])("should pick the newer of %j and %j", (left, right, expected) => {
    expect(newerId(left, right)).toBe(expected);
  });
});

describe("oneLine", () => {
  it("should collapse whitespace when the text spans lines", () => {
    expect(oneLine("  first\n\n  second\tthird ")).toBe("first second third");
  });

  it("should cut the text with an ellipsis when it is too long", () => {
    expect(oneLine("abcdefghij", 5)).toBe("abcd…");
    expect(oneLine("abcde", 5)).toBe("abcde");
  });
});

describe("toolSummary", () => {
  it.each<[string, unknown, string]>([
    ["nothing for no input", undefined, ""],
    ["nothing for a null input", null, ""],
    ["a string input itself", "ls -la", "ls -la"],
    ["the description over the command", { command: "yarn test", description: "Run the unit tests" }, "Run the unit tests"],
    ["the command", { command: "yarn\ntest" }, "yarn test"],
    ["the file path", { file_path: "/src/a.ts", limit: 10 }, "/src/a.ts"],
    ["the JSON when no field is telling", { todos: [1] }, '{"todos":[1]}'],
    ["the JSON on one line when the telling field is blank", { command: "  ", x: 1 }, '{"command":" ","x":1}'],
    ["the JSON of an array", ["a", "b"], '["a","b"]'],
    ["the JSON of a number", 42, "42"]
  ])("should show %s", (_label, input, expected) => {
    expect(toolSummary(input)).toBe(expected);
  });
});
