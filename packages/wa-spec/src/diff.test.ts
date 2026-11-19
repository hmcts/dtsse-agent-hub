import { describe, expect, it } from "vitest";
import { sampleDmn } from "./__fixtures__/dmn.ts";
import { diffDocuments, renderDifferences, ruleOrderMatters } from "./diff.ts";
import { type DmnDocument, parseDmn } from "./dmn-model.ts";

const base = (hitPolicy = "COLLECT"): DmnDocument => parseDmn(sampleDmn("ct_a", { hitPolicy }));
const clone = (doc: DmnDocument): DmnDocument => structuredClone(doc);
const table = (doc: DmnDocument) => doc.decisions[0]?.table as NonNullable<DmnDocument["decisions"][number]["table"]>;

describe("diffDocuments", () => {
  it("should find no differences when only ids, layout and entry whitespace differ", () => {
    const a = base();
    const b = clone(a);
    b.id = "other";
    b.decisions[0]!.id = "renamed-id";
    b.decisions[1]!.id = "Decision_LATEST";
    table(b).rules[0]!.inputs[0] = '"submit",\n   "update"';
    table(b).inputs[1]!.expression = "count(caseData.items)\n  >   0";
    expect(diffDocuments("f", a, b)).toEqual([]);
  });

  it("should report a changed output value when a rule differs", () => {
    const b = clone(base());
    table(b).rules[1]!.outputs[1] = '"Auto"';
    const differences = diffDocuments("f", base(), b);
    expect(differences.map((d) => d.message)).toEqual([expect.stringContaining("only in first: rule 2"), expect.stringContaining("only in second: rule 2")]);
  });

  it("should report hit policy, column and decision-level differences when they change", () => {
    const b = clone(base());
    table(b).hitPolicy = "FIRST";
    table(b).outputs[0]!.typeRef = "integer";
    b.decisions[0]!.historyTimeToLive = "P1D";
    b.decisions.pop();
    const messages = diffDocuments("f", base(), b).map((d) => d.message);
    expect(messages).toContain("historyTimeToLive differs: P30D vs P1D");
    expect(messages.some((m) => m.startsWith("hit policy differs"))).toBe(true);
    expect(messages.some((m) => m.startsWith("output column 1 differs"))).toBe(true);
    expect(messages).toContain("decision only in first");
    expect(renderDifferences(diffDocuments("f", base(), b))).toContain("f [Demo completion]");
  });

  it("should report a changed helper expression and a changed requirement when the decisions differ", () => {
    const b = clone(base());
    b.decisions[1]!.literal = { text: '"other"' };
    b.decisions[0]!.requires = [];
    const messages = diffDocuments("f", base(), b).map((d) => d.message);
    expect(messages.some((m) => m.startsWith("requires differ"))).toBe(true);
    expect(messages.some((m) => m.startsWith("expression differs"))).toBe(true);
  });

  it("should report swapped rules when the hit policy makes order matter", () => {
    const b = clone(base("COLLECT"));
    table(b).rules.reverse();
    expect(diffDocuments("f", base("COLLECT"), b).length).toBeGreaterThan(0);
  });

  it("should ignore swapped rules when the hit policy is UNIQUE or order is waived", () => {
    const unique = base("UNIQUE");
    const b = clone(unique);
    table(b).rules.reverse();
    expect(diffDocuments("f", unique, b)).toEqual([]);
    const collect = base("COLLECT");
    const c = clone(collect);
    table(c).rules.reverse();
    expect(diffDocuments("f", collect, c, { ignoreRuleOrder: true })).toEqual([]);
  });

  it("should still report an added rule when order is ignored", () => {
    const unique = base("UNIQUE");
    const b = clone(unique);
    table(b).rules.push({ inputs: ['"x"', ""], outputs: ['"y"', '"z"'] });
    expect(diffDocuments("f", unique, b).map((d) => d.message)).toEqual(["rule count differs: 2 vs 3", expect.stringContaining("only in second: rule 3")]);
  });
});

describe("ruleOrderMatters", () => {
  it.each([
    ["UNIQUE", undefined, false],
    ["ANY", undefined, false],
    ["COLLECT", "SUM", false],
    ["COLLECT", undefined, true],
    ["RULE ORDER", undefined, true],
    ["FIRST", undefined, true],
    ["PRIORITY", undefined, true],
    ["OUTPUT ORDER", undefined, true]
  ])("should decide %s %s as %s when asked whether rule order matters", (hitPolicy, aggregation, expected) => {
    expect(ruleOrderMatters(hitPolicy, aggregation)).toBe(expected);
  });
});
