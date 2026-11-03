import { describe, expect, it } from "vitest";
import { nameSourceOf } from "./name-source.ts";

describe("nameSourceOf", () => {
  it("should be user only for a name the person chose with /rename", () => {
    expect(nameSourceOf("user")).toBe("user");
  });

  it.each([
    ["derived", "a name the client worked out"],
    ["auto", "Claude Code's own name for the conversation, which is automatic too"],
    ["", "an empty value"],
    ["USER", "a value of the wrong case, since nothing normalises what a client sends"]
  ])("should read %s as derived, being %s", (value) => {
    expect(nameSourceOf(value)).toBe("derived");
  });

  // A client from before the field, and a row written before the column: both say nothing, which is the same thing.
  it.each([[undefined], [null], [7], [{ source: "user" }], [["user"]]])("should read %s as derived when nothing usable was reported", (value) => {
    expect(nameSourceOf(value)).toBe("derived");
  });
});
