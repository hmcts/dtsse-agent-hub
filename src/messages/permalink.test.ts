import { describe, expect, it } from "vitest";
import { messageHref, parseMessageRef } from "./permalink.ts";

describe("parseMessageRef", () => {
  it("should read the id when it is digits within bigint range", () => {
    expect(parseMessageRef("1")).toBe(1n);
    expect(parseMessageRef("1234")).toBe(1234n);
    expect(parseMessageRef("9223372036854775807")).toBe(9_223_372_036_854_775_807n);
  });

  it("should reject the id when it is out of range, zero-padded or not digits", () => {
    for (const raw of ["", "0", "007", "9223372036854775808", "99999999999999999999", "12a", "-1", " 1", "1.0", "١٢"]) {
      expect(parseMessageRef(raw)).toBeNull();
    }
  });
});

describe("messageHref", () => {
  it("should point at the message page when given an id", () => {
    expect(messageHref("42")).toBe("/m/42");
  });
});
