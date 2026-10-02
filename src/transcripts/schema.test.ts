import { describe, expect, it } from "vitest";
import { MAX_BATCH_ENTRIES, MAX_ENTRY_CONTENT_BYTES, MAX_REDACTED_PATTERN } from "./limits.ts";
import { transcriptBody } from "./schema.ts";

const AT = "2026-10-02T09:00:00.000Z";

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { key: "s1:1", role: "assistant", content: { text: "hello" }, occurred_at: AT, ...overrides };
}

function parse(entries: unknown[], sessionId: unknown = "session-1") {
  return transcriptBody.safeParse({ session_id: sessionId, entries });
}

function failure(entries: unknown[], sessionId?: unknown): { path: string; message: string } {
  const result = parse(entries, sessionId);
  if (result.success) {
    throw new Error("expected the body to be refused");
  }
  const issue = result.error.issues[0]!;
  return { path: issue.path.join("."), message: issue.message };
}

describe("transcriptBody", () => {
  it("should default the flags and read the time and message id when an entry leaves them out or sends them", () => {
    const result = parse([entry(), entry({ key: "s1:2", role: "user", content: { text: "hi" }, message_id: "42", truncated: true })]);

    expect(result.success && result.data).toEqual({
      session_id: "session-1",
      entries: [
        { key: "s1:1", role: "assistant", content: { text: "hello" }, truncated: false, redacted: false, message_id: null, occurred_at: new Date(AT) },
        { key: "s1:2", role: "user", content: { text: "hi" }, truncated: true, redacted: false, message_id: 42n, occurred_at: new Date(AT) }
      ]
    });
  });

  it.each<[string, Record<string, unknown>, unknown]>([
    ["a system note", { role: "system", content: { text: "compacted" } }, { text: "compacted" }],
    ["a tool call", { role: "tool_use", content: { id: "t1", name: "Bash", input: { command: "ls" } } }, { id: "t1", name: "Bash", input: { command: "ls" } }],
    [
      "a tool result",
      { role: "tool_result", content: { tool_use_id: "t1", output: "ok", is_error: false } },
      { tool_use_id: "t1", output: "ok", is_error: false }
    ],
    ["a redacted turn", { role: "user", redacted: true, content: { redacted: "aws-key" } }, { redacted: "aws-key" }],
    [
      "a redacted tool call that keeps its tool",
      { role: "tool_use", redacted: true, content: { id: "t1", name: "Read", redacted: "pem" } },
      { id: "t1", name: "Read", redacted: "pem" }
    ],
    ["a redacted tool call that keeps nothing", { role: "tool_use", redacted: true, content: { redacted: "pem" } }, { redacted: "pem" }],
    ["a redacted tool result", { role: "tool_result", redacted: true, content: { redacted: "pem" } }, { redacted: "pem" }]
  ])("should accept %s with its role's content", (_label, overrides, content) => {
    const result = parse([entry(overrides)]);

    expect(result.success && result.data.entries[0]?.content).toEqual(content);
  });

  it("should accept a secret pattern's source up to the limit and refuse a longer one when an entry is redacted", () => {
    expect(parse([entry({ redacted: true, content: { redacted: "x".repeat(MAX_REDACTED_PATTERN) } })]).success).toBe(true);
    expect(failure([entry({ redacted: true, content: { redacted: "x".repeat(MAX_REDACTED_PATTERN + 1) } })]).path).toBe("entries.0.content");
    expect(
      failure([entry({ role: "tool_use", redacted: true, content: { id: "t", name: "Bash", redacted: "x".repeat(MAX_REDACTED_PATTERN + 1) } })]).path
    ).toBe("entries.0.content");
  });

  it("should keep only the fields of the role's content when an entry sends more", () => {
    const result = parse([entry({ content: { text: "hello", extra: "dropped" } })]);

    expect(result.success && result.data.entries[0]?.content).toEqual({ text: "hello" });
  });

  it("should accept an offset time and a null message id when an entry sends them", () => {
    const result = parse([entry({ occurred_at: "2026-10-02T10:00:00.123456+01:00", message_id: null })]);

    expect(result.success && result.data.entries[0]).toMatchObject({ occurred_at: new Date("2026-10-02T09:00:00.123Z"), message_id: null });
  });

  it.each<[string, Record<string, unknown>, string, RegExp]>([
    ["text content for a tool call", { role: "tool_use", content: { text: "x" } }, "entries.0.content", /\{id, name, input\} for a tool_use entry/],
    ["a tool result without is_error", { role: "tool_result", content: { tool_use_id: "t", output: "x" } }, "entries.0.content", /tool_result/],
    ["unredacted content for a redacted entry", { redacted: true, content: { text: "secret" } }, "entries.0.content", /\{redacted\} for a redacted assistant/],
    [
      "unredacted content for a redacted tool call",
      { role: "tool_use", redacted: true, content: { id: "t", name: "Bash", input: {} } },
      "entries.0.content",
      /\{id, name, redacted\} or \{redacted\}/
    ],
    ["content that is not an object", { content: "hello" }, "entries.0.content", /object/],
    ["content that is an array", { content: [] }, "entries.0.content", /object/],
    ["an unknown role", { role: "narrator" }, "entries.0.role", /Invalid enum value/],
    ["a key with a space", { key: "has space" }, "entries.0.key", /letters, digits/],
    ["an empty key", { key: "" }, "entries.0.key", /at least 1/],
    ["a key over 200 characters", { key: "k".repeat(201) }, "entries.0.key", /at most 200/],
    ["a time with no offset", { occurred_at: "2026-10-02T09:00:00" }, "entries.0.occurred_at", /datetime/],
    ["a time that is not one", { occurred_at: "yesterday" }, "entries.0.occurred_at", /datetime/],
    ["a message id that is not one", { message_id: "12a" }, "entries.0.message_id", /must be a message id/],
    ["a numeric message id", { message_id: 12 }, "entries.0.message_id", /Expected string/]
  ])("should refuse %s", (_label, overrides, path, message) => {
    const refused = failure([entry(overrides)]);

    expect(refused.path).toBe(path);
    expect(refused.message).toMatch(message);
  });

  it("should refuse content larger than the limit as JSON and accept it at the limit when the client did not truncate it", () => {
    const overhead = JSON.stringify({ text: "" }).length;

    expect(parse([entry({ content: { text: "a".repeat(MAX_ENTRY_CONTENT_BYTES - overhead) } })]).success).toBe(true);
    expect(failure([entry({ content: { text: "a".repeat(MAX_ENTRY_CONTENT_BYTES - overhead + 1) } })])).toEqual({
      path: "entries.0.content",
      message: `is larger than ${MAX_ENTRY_CONTENT_BYTES} bytes as JSON; truncate it and set truncated`
    });
  });

  it("should count bytes rather than characters when the content is not ASCII", () => {
    const overhead = JSON.stringify({ text: "" }).length;

    expect(failure([entry({ content: { text: "é".repeat((MAX_ENTRY_CONTENT_BYTES - overhead) / 2 + 1) } })]).path).toBe("entries.0.content");
  });

  it.each<[string, unknown[], unknown, string]>([
    ["no entries", [], "session-1", "entries"],
    ["too many entries", Array.from({ length: MAX_BATCH_ENTRIES + 1 }, (_, index) => entry({ key: `k${index}` })), "session-1", "entries"],
    ["a blank session id", [entry()], "  ", "session_id"],
    ["a session id over 200 characters", [entry()], "s".repeat(201), "session_id"]
  ])("should refuse a batch with %s", (_label, entries, sessionId, path) => {
    expect(failure(entries, sessionId).path).toBe(path);
  });

  it("should accept a full batch when it holds the most entries allowed", () => {
    expect(parse(Array.from({ length: MAX_BATCH_ENTRIES }, (_, index) => entry({ key: `k${index}` }))).success).toBe(true);
  });
});
