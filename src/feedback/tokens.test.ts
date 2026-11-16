import { describe, expect, it } from "vitest";
import { isFeedbackToken, newFeedbackToken } from "./tokens.ts";

describe("newFeedbackToken", () => {
  it("should make a different 43-character url-safe token each time", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => newFeedbackToken()));

    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(isFeedbackToken(token)).toBe(true);
    }
  });
});

describe("isFeedbackToken", () => {
  it.each([
    ["too short", "abc"],
    ["one character long", `${"a".repeat(43)}b`],
    ["not url-safe", `${"a".repeat(42)}+`],
    ["padded", `${"a".repeat(42)}=`]
  ])("should refuse a value that is %s", (_label, value) => {
    expect(isFeedbackToken(value)).toBe(false);
  });

  it("should refuse a value that is not a string", () => {
    expect(isFeedbackToken(undefined)).toBe(false);
    expect(isFeedbackToken(43)).toBe(false);
  });
});
