import { describe, expect, it } from "vitest";
import {
  assertFeel,
  escapeLineBreaksInStrings,
  evalExpression,
  FeelSyntaxError,
  matchesEntry,
  toPlain,
  UnsupportedLanguageError,
  withClock
} from "./feel-eval.ts";

describe("evalExpression", () => {
  it("should be null when the expression is empty", () => {
    expect(evalExpression("  ", {})).toBeNull();
  });

  it("should read variables and nested paths when the expression names them", () => {
    expect(evalExpression("a.b.c + 1", { a: { b: { c: 2 } } })).toBe(3);
  });

  it("should be null when a variable is missing", () => {
    expect(evalExpression("missing.field", {})).toBeNull();
  });

  it("should keep a line break inside a string literal when Camunda would", () => {
    expect(evalExpression('"one\n\ntwo \\"quoted\\" \\\\"', {})).toBe('one\n\ntwo "quoted" \\');
  });

  it("should throw the text that failed when the FEEL does not parse", () => {
    expect(() => evalExpression("1 +* 2 (", {})).toThrow(FeelSyntaxError);
    expect(() => evalExpression("1 +* 2 (", {})).toThrow("1 +* 2 (");
  });

  it("should find an item in a list when contains is given one", () => {
    expect(evalExpression('contains(roles, "b")', { roles: ["a", "b"] })).toBe(true);
    expect(evalExpression('contains(roles, "c")', { roles: ["a", "b"] })).toBe(false);
    expect(evalExpression('contains("abc", "b")', {})).toBe(true);
    expect(evalExpression("contains(1, 2)", {})).toBeNull();
  });

  it("should give null from count when its argument is not a list", () => {
    expect(evalExpression("count(a)", { a: { b: [1] } })).toBeNull();
    expect(evalExpression("count(a)", { a: [1, 2] })).toBe(2);
  });

  it("should prefer a variable named count when the case data has one", () => {
    expect(evalExpression("count", { count: 4 })).toBe(4);
  });
});

describe("escapeLineBreaksInStrings", () => {
  it("should leave line breaks outside strings when they are whitespace", () => {
    expect(escapeLineBreaksInStrings('if a\nthen "x"\nelse "y"')).toBe('if a\nthen "x"\nelse "y"');
  });

  it("should escape carriage returns and line feeds inside strings", () => {
    expect(escapeLineBreaksInStrings('"a\r\nb"')).toBe('"a\\r\\nb"');
  });
});

describe("toPlain", () => {
  it("should write a time without zero seconds when Camunda would", () => {
    expect(evalExpression('time("16:00")', {})).toBe("16:00");
    expect(evalExpression('time("16:00:30")', {})).toBe("16:00:30");
  });

  it("should write a date and time with its offset and region as Java does, and without zero seconds", () => {
    expect(evalExpression('date and time("2026-03-10T00:00:00")', {})).toBe("2026-03-10T00:00");
    expect(evalExpression('date and time("2026-03-10T09:30:15")', {})).toBe("2026-03-10T09:30:15");
    expect(evalExpression('date and time("2026-03-10T09:30:00Z")', {})).toBe("2026-03-10T09:30Z[UTC]");
    expect(evalExpression('date and time("2026-07-10T09:30:00@Europe/London")', {})).toBe("2026-07-10T09:30+01:00[Europe/London]");
    expect(evalExpression('date and time("2026-07-10T09:30:00+05:00")', {})).toBe("2026-07-10T09:30+05:00");
  });

  it("should keep zero seconds when a fraction of a second follows them", () => {
    expect(evalExpression('date and time("2026-03-10T09:30:00.5")', {})).toBe("2026-03-10T09:30:00.5");
  });

  it("should keep the seconds and drop the region when the value is inside a context or list", () => {
    expect(evalExpression('{a: date and time("2026-03-10T00:00:00"), b: [time("16:00"), date and time("2026-07-10T09:30:00@Europe/London")]}', {})).toEqual({
      a: "2026-03-10T00:00:00",
      b: ["16:00:00", "2026-07-10T09:30:00+01:00"]
    });
  });

  it("should write dates and durations as ISO text", () => {
    expect(evalExpression('date("2026-01-02")', {})).toBe("2026-01-02");
    expect(evalExpression('duration("P2D")', {})).toBe("P2D");
  });

  it("should convert temporal values inside lists and contexts", () => {
    expect(toPlain({ list: [evalExpression('date("2026-01-02")', {})], n: 1 })).toEqual({ list: ["2026-01-02"], n: 1 });
  });
});

describe("matchesEntry", () => {
  it("should accept anything when the entry is empty or a dash", () => {
    expect(matchesEntry("", "x", {}, undefined)).toBe(true);
    expect(matchesEntry(" - ", "x", {}, undefined)).toBe(true);
  });

  it("should compare the input with a list of values when the entry is one", () => {
    expect(matchesEntry('"a", "b"', "b", {}, undefined)).toBe(true);
    expect(matchesEntry('"a", "b"', "c", {}, undefined)).toBe(false);
    expect(matchesEntry('not("a")', "c", {}, undefined)).toBe(true);
  });

  it("should let the entry read the input by its variable name when the column has one", () => {
    expect(matchesEntry('taskType = "x"', "x", {}, "taskType")).toBe(true);
    expect(matchesEntry('cellInput = "x"', "x", {}, undefined)).toBe(true);
  });

  it("should let the entry read the other variables when it is a boolean expression", () => {
    expect(matchesEntry("limit > 3", null, { limit: 4 }, undefined)).toBe(true);
  });
});

describe("assertFeel", () => {
  it("should accept FEEL in any case and no language", () => {
    expect(() => assertFeel(undefined, "x")).not.toThrow();
    expect(() => assertFeel("", "x")).not.toThrow();
    expect(() => assertFeel("FEEL", "x")).not.toThrow();
  });

  it("should refuse another language when one is named", () => {
    expect(() => assertFeel("juel", "rule 2")).toThrow(UnsupportedLanguageError);
  });
});

describe("withClock", () => {
  it("should leave the clock alone when no instant is given", () => {
    const variables = { a: 1 };
    expect(withClock(variables, undefined)).toBe(variables);
  });

  it("should fix now() and today() at the instant when one is given", () => {
    const variables = withClock({}, "2026-11-20T07:56:00.5Z");
    expect(evalExpression("now()", variables)).toBe("2026-11-20T07:56:00.5Z[UTC]");
    expect(evalExpression("today()", variables)).toBe("2026-11-20");
  });
});
