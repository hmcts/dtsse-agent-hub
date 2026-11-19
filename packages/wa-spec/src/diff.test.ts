import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDmn, sampleDmn } from "./__fixtures__/dmn.ts";
import { diffDocuments, diffInspections, diffPaths, renderDifferences, ruleOrderMatters } from "./diff.ts";
import { type DmnDocument, readDmn, writeDmn } from "./dmn-model.ts";

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
    ["PRIORITY", undefined, true]
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
    const keyed = (caseType: string) => parseDmn(sampleDmn(caseType));
    write(a, "wa-task-completion-demo-one.dmn", keyed("one"));
    write(a, "wa-task-completion-demo-gone.dmn", keyed("gone"));
    write(b, "wa-task-completion-demo-one.dmn", keyed("one"));
    write(b, "wa-task-completion-demo-new.dmn", keyed("new"));
    expect(diffPaths(a, b).map((d) => `${d.file}: ${d.message}`)).toEqual([
      "wa-task-completion-demo-gone.dmn: file only in first",
      "wa-task-completion-demo-new.dmn: file only in second"
    ]);
  });

  it("should compare the two named files when each side is a file", () => {
    const { a, b } = dirs();
    const changed = clone(base());
    table(changed).rules.pop();
    write(a, "wa-task-completion-demo-x.dmn", base());
    write(b, "wa-task-completion-demo-y.dmn", changed);
    const differences = diffPaths(join(a, "wa-task-completion-demo-x.dmn"), join(b, "wa-task-completion-demo-y.dmn"));
    expect(differences.map((d) => d.file)).toEqual(["wa-task-completion-demo-x.dmn", "wa-task-completion-demo-x.dmn"]);
    expect(differences.map((d) => d.message)[0]).toBe("rule count differs: 2 vs 1");
  });
});

describe("diffDocuments variables", () => {
  it("should ignore the id of a helper's variable and compare its name and type when the other file has different ids", () => {
    const b = clone(base());
    const variable = b.decisions[1]?.variable;
    if (!variable) {
      throw new Error("no variable");
    }
    variable.id = "InformationItem_other";
    expect(diffDocuments("f", base(), b)).toEqual([]);
    variable.typeRef = "integer";
    expect(diffDocuments("f", base(), b).map((d) => d.message)).toEqual([expect.stringContaining("variable differs")]);
  });
});

describe("diffDocuments duplicate names in the second document", () => {
  it("should report a name used twice when only the second document repeats it", () => {
    const b = clone(base());
    b.decisions.push({ ...structuredClone(b.decisions[1] as DmnDocument["decisions"][number]), id: "Decision_TWIN" });
    expect(diffDocuments("f", base(), b).map((d) => d.message)).toContain("decision name used 1 times in first and 2 in second");
  });
});

describe("diffPaths constructs the model does not carry", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "wa-spec-diff-"));
  const put = (where: string, name: string, xml: string) => writeFileSync(join(where, name), xml);

  it.each([
    [
      "a description on a decision",
      (xml: string) => xml.replace("<variable", "<description>about</description><variable"),
      "element <description> in <decision>"
    ],
    ["an unknown attribute on an entry", (xml: string) => xml.replace("<inputEntry ", '<inputEntry foo="bar" '), "attribute foo on <inputEntry>"],
    [
      "a version tag on a decision",
      (xml: string) => xml.replace("<decision ", '<decision camunda:versionTag="1" '),
      "attribute camunda:versionTag on <decision>"
    ],
    [
      "output values on an output",
      (xml: string) => xml.replace(/<output /, '<outputValues id="o"><text>"a"</text></outputValues><output '),
      "element <outputValues>"
    ]
  ])("should report %s when only one side has it", (_what, change, construct) => {
    const [a, b] = [dir(), dir()];
    const xml = sampleDmn("ct_a");
    put(a, "wa-task-completion-demo-x.dmn", change(xml));
    put(b, "wa-task-completion-demo-x.dmn", xml);
    const messages = diffPaths(a, b).map((d) => d.message);
    expect(messages).toEqual([expect.stringContaining(`${construct} occurs`)]);
    expect(diffPaths(a, a)).toEqual([]);
  });
});

describe("diffDocuments allowed values", () => {
  it("should treat allowed values as equal when they differ only in layout", () => {
    const a = base();
    const input = table(a).inputs[0];
    if (input) {
      input.allowedValues = '"a","b"';
    }
    const b = clone(a);
    const other = table(b).inputs[0];
    if (other) {
      other.allowedValues = '"a",\n  "b"';
    }
    expect(diffDocuments("f", a, b)).toEqual([]);
    if (other) {
      other.allowedValues = '"a","c"';
    }
    expect(diffDocuments("f", a, b)).toHaveLength(1);
  });
});

describe("diffDocuments with differing columns", () => {
  it("should report the column difference and still compare rules when the column counts match", () => {
    const b = clone(base());
    table(b).inputs[0]!.label = "Renamed";
    table(b).rules[1]!.outputs[0] = '"Changed"';
    const messages = diffDocuments("f", base(), b).map((d) => d.message);
    expect(messages.some((m) => m.startsWith("input column 1 differs"))).toBe(true);
    expect(messages.some((m) => m.startsWith("only in first: rule 2"))).toBe(true);
  });

  it("should not compare rules when the column counts differ", () => {
    const b = clone(base());
    table(b).inputs.pop();
    const messages = diffDocuments("f", base(), b).map((d) => d.message);
    expect(messages).toEqual(["input count differs: 2 vs 1"]);
  });

  it("should treat repeated requirements as one when comparing what a decision requires", () => {
    const b = clone(base());
    const main = b.decisions[0];
    if (main) {
      main.requires = [...main.requires, ...main.requires];
    }
    expect(diffDocuments("f", base(), b)).toEqual([]);
  });
});

describe("diffInspections values", () => {
  const withValue = (value: string, extra = "") => sampleDmn("ct_a").replace("<decision ", `<decision camunda:versionTag="${value}"${extra} `);

  it("should report a changed value of an unmodelled attribute when the count is the same", () => {
    const [a, b] = [readDmn(withValue("1")).inspection, readDmn(withValue("2")).inspection];
    expect(diffInspections("f", a, b).map((d) => d.message)).toEqual(["attribute camunda:versionTag on <decision> differs: 1 vs 2"]);
    expect(diffInspections("f", a, a)).toEqual([]);
  });

  it("should report a changed unmodelled element when the count is the same", () => {
    const element = (text: string) => sampleDmn("ct_a").replace("<variable", `<extensionElements><x:y xmlns:x="u">${text}</x:y></extensionElements><variable`);
    const messages = diffInspections("f", readDmn(element("a")).inspection, readDmn(element("b")).inspection).map((d) => d.message);
    expect(messages).toEqual([expect.stringContaining("element <extensionElements> differs")]);
  });
});

describe("diffPaths pairs files by task key", () => {
  const keyedXml = (key: string, change?: (xml: string) => string) => {
    const xml = sampleDmn("ct_a").replaceAll("wa-task-completion-demo-ct_a", key);
    return change ? change(xml) : xml;
  };
  const dirs = () => {
    const root = mkdtempSync(join(tmpdir(), "wa-spec-diff-"));
    const [a, b] = [join(root, "a"), join(root, "b")];
    mkdirSync(a);
    mkdirSync(b);
    return { a, b };
  };

  it("should compare a file named unlike a task key with the generated file that holds the same key when the directories are compared", () => {
    const { a, b } = dirs();
    const key = "wa-task-completion-svc-x";
    writeFileSync(join(a, "wa-task-completion-possession.dmn"), keyedXml(key));
    writeFileSync(join(b, `${key}.dmn`), keyedXml(key));
    expect(diffPaths(a, b)).toEqual([]);
    writeFileSync(
      join(b, `${key}.dmn`),
      keyedXml(key, (xml) => xml.replace('"Auto"', '"Manual"'))
    );
    expect(diffPaths(a, b).map((d) => d.message)).toEqual([
      expect.stringContaining("only in first: rule 1"),
      expect.stringContaining("only in second: rule 1")
    ]);
  });

  it("should report a task-looking file whose decisions hold no task key and files that share one", () => {
    const { a, b } = dirs();
    writeFileSync(join(a, "wa-task-mystery-thing.dmn"), '<definitions><decision id="x" name="x"/></definitions>');
    writeFileSync(join(a, "other.dmn"), keyedXml("not-a-key"));
    writeFileSync(join(b, "wa-task-completion-one.dmn"), keyedXml("wa-task-completion-svc-x"));
    writeFileSync(join(b, "wa-task-completion-two.dmn"), keyedXml("wa-task-completion-svc-x"));
    const messages = diffPaths(a, b).map((d) => `${d.file}: ${d.message}`);
    expect(messages).toContain("wa-task-mystery-thing.dmn: not a task DMN of a known kind, so not compared (first)");
    expect(messages.join()).toContain("both hold wa-task-completion-svc-x (second)");
    expect(messages.join()).not.toContain("other.dmn");
  });

  it("should name the file when a DMN in a directory cannot be read", () => {
    const { a, b } = dirs();
    writeFileSync(join(a, "broken.dmn"), "<html/>");
    expect(() => diffPaths(a, b)).toThrow(/^broken\.dmn: not a DMN file/);
  });
});
