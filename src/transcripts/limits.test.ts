import { describe, expect, it } from "vitest";
import { contentBytes, ENTRY_KEY_PATTERN, MAX_BATCH_ENTRIES, MAX_ENTRIES_PER_AGENT, MAX_ENTRY_CONTENT_BYTES, RETENTION_DAYS } from "./limits.ts";

describe("transcript limits", () => {
  it("should hold the limits the contract documents when read", () => {
    expect({ MAX_BATCH_ENTRIES, MAX_ENTRY_CONTENT_BYTES, RETENTION_DAYS, MAX_ENTRIES_PER_AGENT }).toEqual({
      MAX_BATCH_ENTRIES: 100,
      MAX_ENTRY_CONTENT_BYTES: 16_384,
      RETENTION_DAYS: 30,
      MAX_ENTRIES_PER_AGENT: 20_000
    });
  });

  it.each([
    ["uuid-1:2", true],
    ["a_b-C9", true],
    ["has space", false],
    ["slash/in", false],
    ["", false]
  ])("should decide whether %j is an entry key", (key, expected) => {
    expect(ENTRY_KEY_PATTERN.test(key)).toBe(expected);
  });
});

describe("contentBytes", () => {
  it("should count the JSON in UTF-8 bytes when the content is not ASCII", () => {
    expect(contentBytes({ text: "a" })).toBe('{"text":"a"}'.length);
    expect(contentBytes({ text: "é" })).toBe('{"text":""}'.length + 2);
    expect(contentBytes({ text: "😀" })).toBe('{"text":""}'.length + 4);
  });
});
