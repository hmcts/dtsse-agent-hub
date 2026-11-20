import { describe, expect, it } from "vitest";
import type { DmnDecision, DmnDocument, DmnRule, DmnTable } from "../dmn-model.ts";
import { DmnEvaluationError, evaluateDecision, evaluateTable } from "./dmn-eval.ts";
import { UnsupportedLanguageError } from "./feel-eval.ts";

const rule = (inputs: string[], outputs: string[], extra: Partial<DmnRule> = {}): DmnRule => ({ inputs, outputs, ...extra });

/** A one-input table over `x`, with the output `out`. */
const table = (hitPolicy: string, rules: DmnRule[], extra: Partial<DmnTable> = {}): DmnTable => ({
  hitPolicy,
  inputs: [{ expression: "x", typeRef: "string" }],
  outputs: [{ name: "out" }],
  rules,
  ...extra
});

const rows = (hitPolicy: string, x: string, rules: DmnRule[], extra: Partial<DmnTable> = {}) => evaluateTable(table(hitPolicy, rules, extra), { x });

describe("hit policies", () => {
  const overlapping = [rule(['"a"'], ['"first"']), rule(['"a", "b"'], ['"second"']), rule(['"c"'], ['"third"'])];

  it("should give the one matching rule when the policy is UNIQUE", () => {
    expect(rows("UNIQUE", "b", overlapping)).toEqual([{ out: "second" }]);
    expect(rows("UNIQUE", "z", overlapping)).toEqual([]);
  });

  it("should fail when two rules match and the policy is UNIQUE", () => {
    expect(() => rows("UNIQUE", "a", overlapping)).toThrow(DmnEvaluationError);
  });

  it("should give the first matching rule when the policy is FIRST", () => {
    expect(rows("FIRST", "a", overlapping)).toEqual([{ out: "first" }]);
  });

  it("should give the shared output when the policy is ANY and the matching rules agree", () => {
    expect(rows("ANY", "a", [rule(['"a"'], ['"same"']), rule(['"a"'], ['"same"'])])).toEqual([{ out: "same" }]);
  });

  it("should fail when the policy is ANY and the matching rules differ", () => {
    expect(() => rows("ANY", "a", overlapping)).toThrow("ANY hit policy");
  });

  it("should give every matching rule in rule order when the policy is RULE ORDER or COLLECT", () => {
    expect(rows("RULE ORDER", "a", overlapping)).toEqual([{ out: "first" }, { out: "second" }]);
    expect(rows("COLLECT", "a", overlapping)).toEqual([{ out: "first" }, { out: "second" }]);
  });

  it("should fail when the hit policy is one the spec does not have", () => {
    expect(() => rows("PRIORITY", "a", overlapping)).toThrow("not supported");
  });
});

describe("COLLECT with an aggregation", () => {
  const numbers = [rule([""], ["3"]), rule([""], ["4"]), rule([""], ["4"]), rule(['"never"'], ["100"])];

  it("should sum the matching outputs when the aggregation is SUM", () => {
    expect(rows("COLLECT", "a", numbers, { aggregation: "SUM" })).toEqual([{ out: 11 }]);
  });

  it("should count the distinct matching outputs when the aggregation is COUNT", () => {
    expect(rows("COLLECT", "a", numbers, { aggregation: "COUNT" })).toEqual([{ out: 2 }]);
  });

  it("should give the smallest or largest output when the aggregation is MIN or MAX", () => {
    expect(rows("COLLECT", "a", numbers, { aggregation: "MIN" })).toEqual([{ out: 3 }]);
    expect(rows("COLLECT", "a", numbers, { aggregation: "MAX" })).toEqual([{ out: 4 }]);
  });

  it("should give nothing for MIN and MAX and zero for SUM and COUNT when no rule matches", () => {
    const none = [rule(['"never"'], ["1"])];
    expect(rows("COLLECT", "a", none, { aggregation: "MIN" })).toEqual([]);
    expect(rows("COLLECT", "a", none, { aggregation: "MAX" })).toEqual([]);
    expect(rows("COLLECT", "a", none, { aggregation: "SUM" })).toEqual([{ out: 0 }]);
    expect(rows("COLLECT", "a", none, { aggregation: "COUNT" })).toEqual([{ out: 0 }]);
  });
});

describe("inputs and outputs", () => {
  it("should read the variable the column names when its input expression is empty", () => {
    const t = table("COLLECT", [rule(['"go"'], ['"hit"'])], { inputs: [{ expression: "", inputVariable: "event" }] });
    expect(evaluateTable(t, { event: "go" })).toEqual([{ out: "hit" }]);
    expect(evaluateTable(t, {})).toEqual([]);
  });

  it("should keep an input's date type when the entries compare it with dates", () => {
    const t = table("COLLECT", [rule(['< date("2026-02-01")'], ['"early"']), rule(['>= date("2026-02-01")'], ['"late"'])], {
      inputs: [{ expression: "date(d)" }]
    });
    expect(evaluateTable(t, { d: "2026-01-15" })).toEqual([{ out: "early" }]);
    expect(evaluateTable(t, { d: "2026-03-01" })).toEqual([{ out: "late" }]);
  });

  it("should convert an input to its type when the column has one", () => {
    const t = table("COLLECT", [rule(["true"], ['"yes"'])], { inputs: [{ expression: "flag", typeRef: "boolean" }] });
    expect(evaluateTable(t, { flag: "true" })).toEqual([{ out: "yes" }]);
    expect(evaluateTable(t, { flag: "no" })).toEqual([]);
  });

  it("should leave an output out when its entry is empty and keep it as null when the entry says null", () => {
    const t = table("COLLECT", [rule([""], ["", "null"])], { outputs: [{ name: "a" }, { name: "b" }] });
    expect(evaluateTable(t, {})).toEqual([{ b: null }]);
  });

  it("should give an empty row when a rule has no outputs", () => {
    expect(rows("COLLECT", "a", [rule([""], [""])])).toEqual([{}]);
  });

  it("should convert outputs to the type their column names", () => {
    const outputs = ["string", "integer", "long", "double", "boolean", "other", "integer"].map((typeRef, i) => ({ name: `o${i}`, typeRef }));
    const t = table("COLLECT", [rule([""], ["5", '"7.9"', '"12"', '"1.5"', '"true"', "[1]", "null"])], { outputs });
    expect(evaluateTable(t, {})).toEqual([{ o0: "5", o1: 7, o2: 12, o3: 1.5, o4: true, o5: [1], o6: null }]);
  });

  it("should keep an object when its column is typed string", () => {
    const t = table("COLLECT", [rule([""], ["{a: 1}"])], { outputs: [{ name: "o", typeRef: "string" }] });
    expect(evaluateTable(t, {})).toEqual([{ o: { a: 1 } }]);
  });

  it("should convert a number to an integer or double from a number or a string", () => {
    const t = table("COLLECT", [rule([""], ["7.9", "2"])], {
      outputs: [
        { name: "i", typeRef: "integer" },
        { name: "d", typeRef: "double" }
      ]
    });
    expect(evaluateTable(t, {})).toEqual([{ i: 7, d: 2 }]);
  });

  it("should fail when an entry is in another expression language", () => {
    expect(() => evaluateTable(table("COLLECT", [rule([""], ['"x"'], { outputLanguages: ["groovy"] })]), {})).toThrow(UnsupportedLanguageError);
    expect(() => evaluateTable(table("COLLECT", [rule(['"x"'], ['"x"'], { inputLanguages: ["juel"] })]), {})).toThrow(UnsupportedLanguageError);
    expect(() => evaluateTable(table("COLLECT", [], { inputs: [{ expression: "x", expressionLanguage: "juel" }] }), {})).toThrow(UnsupportedLanguageError);
  });
});

describe("evaluateDecision", () => {
  const literal = (id: string, name: string, text: string, requires: string[] = [], typeRef?: string): DmnDecision => ({
    id,
    name,
    requires,
    variable: { name, ...(typeRef ? { typeRef } : {}) },
    literal: { text }
  });
  const document = (...decisions: DmnDecision[]): DmnDocument => ({ id: "d", name: "DRD", decisions });
  const main = (requires: string[], t: DmnTable): DmnDecision => ({ id: "main", name: "main", requires, table: t });

  it("should expose a required literal under its variable name when the main table reads it", () => {
    const doc = document(
      main(["lit"], table("COLLECT", [rule(['"AB"'], ['"found " + upper'])], { inputs: [{ expression: "upper" }] })),
      literal("lit", "upper", "upper case(x)")
    );
    expect(evaluateDecision(doc, "main", { x: "ab" })).toEqual([{ out: "found AB" }]);
  });

  it("should keep a required literal's date type when a later table compares it", () => {
    const doc = document(
      main(["l"], table("COLLECT", [rule(['< date("2026-02-01")'], ['"early"'])], { inputs: [{ expression: "when" }] })),
      literal("l", "when", 'date("2026-01-15")')
    );
    expect(evaluateDecision(doc, "main", {})).toEqual([{ out: "early" }]);
  });

  it("should evaluate a required decision's own requirements first and once when they are shared", () => {
    const doc = document(
      main(["b", "c"], table("COLLECT", [rule([""], ["b + c"])])),
      literal("b", "b", "a + 1", ["a"]),
      literal("c", "c", "a + 2", ["a"]),
      literal("a", "a", "10")
    );
    expect(evaluateDecision(doc, "main", {})).toEqual([{ out: 23 }]);
  });

  const helperTable = (t: Omit<DmnTable, "inputs">): DmnDecision => ({ id: "h", name: "h", requires: [], table: { inputs: [], ...t } });
  const readsHelper = (expression: string, helper: DmnDecision) =>
    evaluateDecision(document(main(["h"], table("COLLECT", [rule([""], [expression])])), helper), "main", {});

  it("should expose a required table's output columns by name when one rule matched, whatever the decision's variable", () => {
    const helper = helperTable({ hitPolicy: "FIRST", outputs: [{ name: "v" }, { name: "w" }], rules: [rule([], ['"a"', "1"])] });
    expect(readsHelper("v + string(w)", helper)).toEqual([{ out: "a1" }]);
    expect(readsHelper("h", { ...helper, variable: { name: "h" } })).toEqual([{ out: null }]);
  });

  it("should expose each output column as the list of every matching rule's value when several rules matched", () => {
    const helper = helperTable({ hitPolicy: "COLLECT", outputs: [{ name: "v" }, { name: "w" }], rules: [rule([], ['"a"', "1"]), rule([], ['"b"', ""])] });
    expect(readsHelper("v", helper)).toEqual([{ out: ["a", "b"] }]);
    expect(readsHelper("w", helper)).toEqual([{ out: [1] }]);
  });

  it("should expose a list even when one rule matched when the required table is COLLECT or RULE ORDER", () => {
    const rules = [rule([], ['"a"'])];
    expect(readsHelper("v", helperTable({ hitPolicy: "COLLECT", outputs: [{ name: "v" }], rules }))).toEqual([{ out: ["a"] }]);
    expect(readsHelper("v", helperTable({ hitPolicy: "RULE ORDER", outputs: [{ name: "v" }], rules }))).toEqual([{ out: ["a"] }]);
  });

  it("should expose nothing when no rule of a required table matched", () => {
    const helper = helperTable({ hitPolicy: "FIRST", outputs: [{ name: "v" }], rules: [] });
    expect(readsHelper("v", helper)).toEqual([{ out: null }]);
  });

  it("should expose the aggregate under the output column when the required table aggregates", () => {
    const helper = helperTable({ hitPolicy: "COLLECT", aggregation: "SUM", outputs: [{ name: "v" }], rules: [rule([], ["1"]), rule([], ["2"])] });
    expect(readsHelper("v", helper)).toEqual([{ out: 3 }]);
  });

  it("should give a literal decision as one row under its variable name and convert it to its type", () => {
    expect(evaluateDecision(document(literal("l", "total", '"4"', [], "integer")), "l", {})).toEqual([{ total: 4 }]);
  });

  it("should fail when the decision is not in the document", () => {
    expect(() => evaluateDecision(document(), "nope", {})).toThrow("not in the document");
  });

  it("should fail when a literal is in another expression language", () => {
    const l: DmnDecision = { id: "l", name: "l", requires: [], literal: { text: "1", expressionLanguage: "juel" } };
    expect(() => evaluateDecision(document(l), "l", {})).toThrow(UnsupportedLanguageError);
  });

  it("should name a literal by its decision when it has no variable and leave it out of what others read", () => {
    const l: DmnDecision = { id: "l", name: "plain", requires: [], literal: { text: "5" } };
    expect(evaluateDecision(document(l), "l", {})).toEqual([{ plain: 5 }]);
    const empty: DmnDecision = { id: "e", name: "empty", requires: [], variable: { name: "empty" }, literal: { text: "" } };
    expect(evaluateDecision(document(empty), "e", {})).toEqual([{ empty: null }]);
  });
});
