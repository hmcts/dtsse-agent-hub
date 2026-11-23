import type { Field, FormSpec } from "@hmcts-cft/bulk-scan-spec";
import { describe, expect, it } from "vitest";
import { afterSectionMove, afterSectionRemove, fieldFlags, fieldName, matchesQuery, needsReview, reviewRank, reviewTotal } from "./outline.ts";

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

describe("reviewRank", () => {
  it("should rank a TODO or low marker first, then medium, then high, and an unflagged field last", () => {
    const marker = (confidence: "low" | "medium" | "high") => ({ about: "key" as const, reason: "r", confidence });
    expect(reviewRank(field({ todo: ["TODO: a"] }))).toBe(0);
    expect(reviewRank(field({ review: [marker("high"), marker("low")] }))).toBe(0);
    expect(reviewRank(field({ review: [marker("medium"), marker("high")] }))).toBe(1);
    expect(reviewRank(field({ review: [marker("high")] }))).toBe(2);
    expect(reviewRank(field({}))).toBe(3);
  });
});

describe("afterSectionMove", () => {
  it("should follow the open item when its section moves, and shift it when it is the one swapped with", () => {
    expect(afterSectionMove({ section: 1, field: 2 }, 1, -1)).toEqual({ section: 0, field: 2 });
    expect(afterSectionMove({ section: 0, field: 2 }, 1, -1)).toEqual({ section: 1, field: 2 });
    expect(afterSectionMove({ section: 3, field: null }, 1, 1)).toEqual({ section: 3, field: null });
    expect(afterSectionMove(null, 1, 1)).toBeNull();
  });
});

describe("afterSectionRemove", () => {
  it("should keep the open field when another section is removed, renumbering it when the section was before it", () => {
    expect(afterSectionRemove({ section: 2, field: 1 }, 0, 3)).toEqual({ section: 1, field: 1 });
    expect(afterSectionRemove({ section: 0, field: 1 }, 2, 3)).toEqual({ section: 0, field: 1 });
  });

  it("should open the section beside the removed one when the open item was in it, and nothing when it was the last", () => {
    expect(afterSectionRemove({ section: 2, field: 1 }, 2, 3)).toEqual({ section: 1, field: null });
    expect(afterSectionRemove({ section: 0, field: 1 }, 0, 3)).toEqual({ section: 0, field: null });
    expect(afterSectionRemove({ section: 0, field: 1 }, 0, 1)).toBeNull();
  });
});
