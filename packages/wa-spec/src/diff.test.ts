import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sampleDmn } from "./__fixtures__/dmn.ts";
import { diffDocuments, diffPaths, renderDifferences, ruleOrderMatters } from "./diff.ts";
import { type DmnDocument, parseDmn, writeDmn } from "./dmn-model.ts";

const base = (hitPolicy = "COLLECT"): DmnDocument => parseDmn(sampleDmn("ct_a", { hitPolicy }));
const clone = (doc: DmnDocument): DmnDocument => structuredClone(doc);
const table = (doc: DmnDocument) => doc.decisions[0]?.table as NonNullable<DmnDocument["decisions"][number]["table"]>;

describe("diffDocuments", () => {
  it("should find no differences when only ids, layout and entry whitespace differ", () => {
    const a = base();
    const b = clone(a);
    b.id = "other";
    b.decisions[1]!.id = "Decision_LATEST";
    table(b).rules[0]!.inputs[0] = '"submit",\n   "update"';
    table(b).inputs[1]!.expression = "sort(caseData.items,\n  function(x,   y) x > y)";
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

describe("diffDocuments decisions", () => {
  it("should report a different id when the decision table's id differs", () => {
    const b = clone(base());
    b.decisions[0]!.id = "renamed-id";
    expect(diffDocuments("f", base(), b).map((d) => d.message)).toEqual(["decision id differs: wa-task-completion-demo-ct_a vs renamed-id"]);
  });

  it("should report duplicate names and match them in order when two decisions share a name", () => {
    const a = clone(base());
    const twin = structuredClone(a.decisions[1] as DmnDocument["decisions"][number]);
    twin.id = "Decision_TWIN";
    twin.literal = { text: '"other"' };
    a.decisions.push(twin);
    const b = clone(a);
    expect(diffDocuments("f", a, b).map((d) => d.message)).toEqual(["decision name used 2 times in first and 2 in second"]);
    (b.decisions[2] as DmnDocument["decisions"][number]).literal = { text: '"changed"' };
    const messages = diffDocuments("f", a, b).map((d) => d.message);
    expect(messages).toContain("decision name used 2 times in first and 2 in second");
    expect(messages.some((m) => m.startsWith("expression differs"))).toBe(true);
  });

  it("should report a decision only in the second when it has a name the first lacks", () => {
    const b = clone(base());
    b.decisions.push({ id: "Decision_NEW", name: "NEW", requires: [], literal: { text: "1" } });
    expect(diffDocuments("f", base(), b).map((d) => d.message)).toEqual(["decision only in second"]);
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

describe("diffPaths", () => {
  const write = (dir: string, name: string, doc: DmnDocument) => writeFileSync(join(dir, name), writeDmn(doc));
  const dirs = () => {
    const root = mkdtempSync(join(tmpdir(), "wa-spec-diff-"));
    const [a, b] = [join(root, "a"), join(root, "b")];
    mkdirSync(a);
    mkdirSync(b);
    return { a, b };
  };

  it("should list files present on one side only and compare the rest when two directories are given", () => {
    const { a, b } = dirs();
    write(a, "one.dmn", base());
    write(a, "gone.dmn", base());
    write(b, "one.dmn", base());
    write(b, "new.dmn", base());
    expect(diffPaths({ dir: a }, { dir: b }).map((d) => `${d.file}: ${d.message}`)).toEqual(["gone.dmn: file only in first", "new.dmn: file only in second"]);
  });

  it("should compare the two named files when each side is a file", () => {
    const { a, b } = dirs();
    const changed = clone(base());
    table(changed).rules.pop();
    write(a, "x.dmn", base());
    write(b, "y.dmn", changed);
    const differences = diffPaths({ dir: a, file: "x.dmn" }, { dir: b, file: "y.dmn" });
    expect(differences.map((d) => d.file)).toEqual(["x.dmn", "x.dmn"]);
    expect(differences.map((d) => d.message)[0]).toBe("rule count differs: 2 vs 1");
  });
});
