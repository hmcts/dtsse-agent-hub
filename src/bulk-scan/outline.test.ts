import type { Field, FormSpec } from "@hmcts-cft/bulk-scan-spec";
import { describe, expect, it } from "vitest";
import { fieldFlags, fieldName, matchesQuery, needsReview, reviewTotal } from "./outline.ts";

const field = (over: Partial<Field>): Field => ({
  role: "field",
  label: "",
  inputType: "text",
  mandatory: "optional",
  keys: [],
  ccd: [],
  rules: [],
  todo: [],
  ...over
});

describe("fieldFlags", () => {
  it("should count open markers and TODOs when a field has them", () => {
    const flags = fieldFlags(field({ todo: ["TODO: a"], review: [{ about: "key", reason: "guessed", confidence: "low" }] }));
    expect(flags).toEqual({ review: 1, todo: 1, english: false });
  });

  it("should report English when the sheet's logic is text or a branch holds an action", () => {
    expect(fieldFlags(field({ logicText: "If x" })).english).toBe(true);
    expect(fieldFlags(field({ rules: [{ action: "tell them" }] })).english).toBe(true);
    expect(fieldFlags(field({ rules: [{}] })).english).toBe(false);
  });
});

describe("needsReview and reviewTotal", () => {
  it("should count the fields with an open marker or TODO when the spec is summed", () => {
    const spec = {
      sections: [
        { id: "1", title: "A", fields: [field({ todo: ["TODO: a"] }), field({}), field({ review: [{ about: "ccd", reason: "r", confidence: "low" }] })] }
      ]
    } as unknown as FormSpec;
    expect(reviewTotal(spec)).toBe(2);
    expect(needsReview(field({}))).toBe(false);
  });
});

describe("matchesQuery", () => {
  const f = field({ id: "1.2", label: "Date of Birth", keys: ["dobDay"], ccd: ["applicantDob"] });

  it("should match any case of the id, label, key or CCD id when a query is typed", () => {
    for (const query of ["1.2", "birth", "DOBDAY", "applicantdob", "  birth "]) {
      expect(matchesQuery(f, query)).toBe(true);
    }
    expect(matchesQuery(f, "nothing")).toBe(false);
  });

  it("should match every field when the query is blank", () => {
    expect(matchesQuery(f, "  ")).toBe(true);
  });
});

describe("fieldName", () => {
  it("should prefer the id, then the first key, then the label, then the place", () => {
    expect(fieldName(field({ id: "1.1", keys: ["k"], label: "L" }), 0)).toBe("1.1");
    expect(fieldName(field({ keys: ["k"], label: "L" }), 0)).toBe("k");
    expect(fieldName(field({ label: "L" }), 0)).toBe("L");
    expect(fieldName(field({}), 2)).toBe("field 3");
  });
});
