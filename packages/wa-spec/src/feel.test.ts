import { describe, expect, it } from "vitest";
import { canonicalCell, canonicalExpr, normaliseFeel, parseCell, parseExpr, renderCell, renderExpr } from "./feel.ts";

describe("parseExpr", () => {
  it("should read scalars as themselves when the text is a literal", () => {
    expect(parseExpr('"routine_work"')).toBe("routine_work");
    expect(parseExpr(" 5000 ")).toBe(5000);
    expect(parseExpr("false")).toBe(false);
    expect(parseExpr("null")).toBeNull();
  });

  it("should return undefined when the entry is empty", () => {
    expect(parseExpr("  \n ")).toBeUndefined();
  });

  it("should read a guarded field as an if over exists conditions when the FEEL is a null-checked path", () => {
    const text = 'if (caseData.location != null and caseData.location.region != null) then caseData.location.region else "1"';
    expect(parseExpr(text)).toEqual({
      if: {
        all: [
          { field: "caseData.location", op: "exists" },
          { field: "caseData.location.region", op: "exists" }
        ]
      },
      use: { field: "caseData.location.region" },
      otherwise: "1"
    });
  });

  it("should read comparisons, or groups and string joins when they use only the supported forms", () => {
    expect(parseExpr('if (a = "Yes" or b >= 3) then 1000 else 5000')).toEqual({
      if: {
        any: [
          { field: "a", op: "eq", value: "Yes" },
          { field: "b", op: "ge", value: 3 }
        ]
      },
      use: 1000,
      otherwise: 5000
    });
    expect(parseExpr('"Arrange Support - " + NAME')).toEqual({ plus: ["Arrange Support - ", { field: "NAME" }] });
  });

  it("should keep the text as raw FEEL when it uses a function call or any other unsupported construct", () => {
    expect(parseExpr("now()")).toEqual({ feel: "now()" });
    expect(parseExpr("if x != null then count(y) else 0")).toEqual({ feel: "if x != null then count(y) else 0" });
    expect(parseExpr('"a\\"b"')).toEqual({ feel: '"a\\"b"' });
    expect(parseExpr("1.50")).toEqual({ feel: "1.50" });
  });

  it("should keep the text as raw FEEL when an if condition is not a comparison", () => {
    expect(parseExpr("if flag then 1 else 2")).toEqual({ feel: "if flag then 1 else 2" });
  });
});

describe("renderExpr", () => {
  it.each([
    '"plain"',
    "42",
    "true",
    "null",
    'if (a != null) then a else "x"',
    'if (a = "Y" and (b = 1 or c = 2)) then 1 else 2',
    '"EJ - " + (if (t != null) then t else "x")',
    "caseData.nextListedDate"
  ])("should reproduce %s when it is parsed and rendered again", (text) => {
    const first = parseExpr(text);
    expect(parseExpr(renderExpr(first))).toEqual(first);
  });

  it("should escape quotes in a string scalar when rendering", () => {
    expect(renderExpr('say "hi"')).toBe('"say \\"hi\\""');
  });

  it("should render an empty entry when the value is absent", () => {
    expect(renderExpr(undefined)).toBe("");
  });
});

describe("cells", () => {
  it("should read a list of literals as an in-list when the entry is a comma-separated list", () => {
    expect(parseCell('"a",\n "b" ,"c"')).toEqual({ in: ["a", "b", "c"] });
    expect(parseCell("true")).toEqual({ in: [true] });
    expect(renderCell({ in: ["a", "b"] })).toBe('"a", "b"');
  });

  it("should read negation and comparisons when the entry uses them", () => {
    expect(parseCell('not("a","b")')).toEqual({ notIn: ["a", "b"] });
    expect(parseCell("> 5")).toEqual({ cmp: ">", value: 5 });
    expect(renderCell({ notIn: ["a"] })).toBe('not("a")');
    expect(renderCell({ cmp: "<=", value: 3 })).toBe("<= 3");
  });

  it("should keep raw FEEL when the entry is outside the cell forms", () => {
    expect(parseCell("[1..5]")).toEqual({ feel: "[1..5]" });
    expect(parseCell("")).toBeUndefined();
    expect(renderCell(undefined)).toBe("");
  });
});

describe("canonical forms", () => {
  it("should treat entries as equal when they differ only in layout", () => {
    expect(canonicalCell('"a",\n"b"')).toBe(canonicalCell('"a", "b"'));
    expect(canonicalExpr("if(a!=null)then 1 else 2")).toBe(canonicalExpr("if (a != null)\nthen 1\nelse 2"));
    expect(canonicalExpr("count(a)  +   1")).toBe(canonicalExpr("count(a) + 1"));
  });

  it("should treat entries as different when a string literal differs in spacing", () => {
    expect(canonicalExpr('"a  b"')).not.toBe(canonicalExpr('"a b"'));
  });

  it("should collapse whitespace outside strings only when normalising FEEL", () => {
    expect(normaliseFeel('  x   +  "a  b" ')).toBe('x + "a  b"');
  });
});
