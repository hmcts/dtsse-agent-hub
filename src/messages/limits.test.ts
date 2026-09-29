import { describe, expect, it } from "vitest";
import { messageIdOf } from "./limits.ts";

describe("messageIdOf", () => {
  it("should read the largest bigint exactly when it is written in full", () => {
    expect(messageIdOf("9223372036854775807")).toBe(9_223_372_036_854_775_807n);
  });

  it.each([
    ["empty", ""],
    ["negative", "-1"],
    ["a decimal", "1.5"],
    ["twenty digits", "12345678901234567890"],
    ["one past the largest bigint", "9223372036854775808"]
  ])("should give undefined when the value is %s", (_label, value) => {
    expect(messageIdOf(value)).toBeUndefined();
  });
});
