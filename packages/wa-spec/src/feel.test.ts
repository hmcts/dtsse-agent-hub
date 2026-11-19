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

  it("should keep the text as raw FEEL when it uses a lambda, a filter or any other unsupported construct", () => {
    for (const text of [
      "sort(a, function(x, y) x > y)",
      "a[x > 1]",
      "if x != null then count(y) else",
      '"a\\"b"',
      "1.50",
      "-1",
      "a.b.",
      "some x in a",
      "f(a b)"
    ]) {
      expect(parseExpr(text)).toEqual({ feel: text });
    }
  });

  it("should read function calls, including multi-word names, as a call over its arguments when the FEEL calls a built-in", () => {
    expect(parseExpr("now()")).toEqual({ call: "now", args: [] });
    expect(parseExpr('time("16:00")')).toEqual({ call: "time", args: ["16:00"] });
    expect(parseExpr('starts with(a.title, "EJ - ")')).toEqual({ call: "starts with", args: [{ field: "a.title" }, "EJ - "] });
    expect(parseExpr('date and time(x, "y")')).toEqual({ call: "date and time", args: [{ field: "x" }, "y"] });
  });

  it("should read subtraction and any comparison between expressions when the operands are not a field and a literal", () => {
    expect(parseExpr('if (date(d) - today()) <= duration("P3D") then 1 else 2')).toEqual({
      if: {
        left: {
          minus: [
            { call: "date", args: [{ field: "d" }] },
            { call: "today", args: [] }
          ]
        },
        op: "le",
        right: { call: "duration", args: ["P3D"] }
      },
      use: 1,
      otherwise: 2
    });
    expect(parseExpr("a - b + c")).toEqual({ plus: [{ minus: [{ field: "a" }, { field: "b" }] }, { field: "c" }] });
    expect(parseExpr("if month(d) = 2 then 18 else 20")).toMatchObject({ if: { left: { call: "month" }, op: "eq", right: 2 } });
  });

  it("should read a bare boolean as a truthy condition when an if or and tests a name or call", () => {
    expect(parseExpr("if flag then 1 else 2")).toEqual({ if: { truthy: { field: "flag" } }, use: 1, otherwise: 2 });
    expect(parseExpr("(A and B)")).toEqual({ all: [{ truthy: { field: "A" } }, { truthy: { field: "B" } }] });
  });

  it("should read an index in a path and a quantifier over a list when the FEEL uses them", () => {
    expect(parseExpr("a.list[1].value.x")).toEqual({ field: "a.list[1].value.x" });
    expect(parseExpr("some item in a.list satisfies (item.v != null and item.w = true)")).toEqual({
      quantifier: "some",
      variable: "item",
      over: { field: "a.list" },
      satisfies: {
        all: [
          { field: "item.v", op: "exists" },
          { field: "item.w", op: "eq", value: true }
        ]
      }
    });
    expect(parseExpr("every x in l satisfies x.a = 1")).toMatchObject({ quantifier: "every" });
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
    "caseData.nextListedDate",
    "now()",
    'starts with(t, "EJ - ")',
    "if (month(d) = 2 or month(d) = 4) then 18 else 20",
    'if ((date(d) - today()) <= duration("P3D")) then 1 else 2',
    "(A and B)",
    "a.list[1].value.x",
    "if (a != null and some i in a.list satisfies (i.v = 1 and i.w != null)) then true else false",
    "a - b + c",
    "if (flag) then f(a, b) else null"
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

describe("normaliseFeel", () => {
  it("should collapse whitespace outside strings and keep it inside when the text has both", () => {
    expect(normaliseFeel('  if   a  =  "x   y"\n then 1  ')).toBe('if a = "x   y" then 1');
  });

  it("should keep an escaped quote inside the string when normalising", () => {
    expect(normaliseFeel('a  =  "say \\"  hi  \\"" and   b')).toBe('a = "say \\"  hi  \\"" and b');
  });

  it("should leave unlexable characters in place when the text has any", () => {
    expect(normaliseFeel("a[ 1 ]   ??")).toBe("a[ 1 ] ??");
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
