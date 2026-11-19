import { describe, expect, it } from "vitest";
import { sampleDmn } from "./__fixtures__/dmn.ts";
import { parseDmn, writeDmn } from "./dmn-model.ts";
import { generateAll } from "./generator.ts";
import { importDmns, renderReport } from "./importer.ts";
import { validateSpec } from "./schema.ts";

const file = (caseType: string, options?: Parameters<typeof sampleDmn>[1]) => ({
  name: `wa-task-completion-demo-${caseType}.dmn`,
  xml: sampleDmn(caseType, options)
});

describe("importDmns", () => {
  it("should share one set of columns and rows across case types when their DMNs are identical", () => {
    const { spec } = importDmns([file("ct_a"), file("ct_b")]);
    const completion = spec.decisions.completion;
    expect(spec.service.slug).toBe("demo");
    expect(spec.caseTypes.map((c) => c.id)).toEqual(["ct_a", "ct_b"]);
    expect(completion?.rows).toHaveLength(2);
    expect(completion?.rows.every((row) => row.only === undefined)).toBe(true);
    expect(completion?.inputs.map((c) => c.key)).toEqual(["eventId", "closed"]);
    expect(completion?.overrides).toBeUndefined();
    expect(validateSpec(spec)).toEqual([]);
  });

  it("should scope a row and override the name when only one case type differs", () => {
    const { spec } = importDmns([file("ct_a"), file("ct_b", { extraRule: true, name: "Demo B" })]);
    const completion = spec.decisions.completion;
    expect(completion?.rows).toHaveLength(3);
    expect(completion?.rows[2]?.only).toEqual(["ct_b"]);
    expect(completion?.overrides).toEqual({ ct_b: { name: "Demo B" } });
  });

  it("should structure cells and expressions and keep a helper with its dependency when the DMN has them", () => {
    const { spec } = importDmns([file("ct_a")]);
    const completion = spec.decisions.completion;
    expect(completion?.rows[0]).toEqual({ when: { eventId: { in: ["submit", "update"] } }, returns: { taskType: "Review", completionMode: "Auto" } });
    expect(completion?.rows[1]?.description).toBe("cancel on dispose");
    expect(completion?.rows[1]?.when?.closed).toEqual({ in: [true] });
    expect(completion?.helpers?.[0]?.name).toBe("LATEST");
    expect(completion?.dependencies).toEqual([{ decision: "table", requires: "LATEST" }]);
    expect(completion?.inputs[1]?.expression).toEqual({ feel: "sort(caseData.items, function(x, y) x > y)" });
  });

  it("should record a differing hit policy as an override when case types disagree", () => {
    const { spec } = importDmns([file("ct_a"), file("ct_b", { hitPolicy: "FIRST" }), file("ct_c")]);
    expect(spec.decisions.completion?.hitPolicy).toBe("COLLECT");
    expect(spec.decisions.completion?.overrides).toEqual({ ct_b: { hitPolicy: "FIRST" } });
  });

  it("should report raw FEEL and presentation, and nothing unrepresentable, when the files use only known constructs", () => {
    const { report } = importDmns([file("ct_a"), file("ct_b")]);
    expect(report.unrepresentable).toEqual([]);
    expect(report.entries.completion).toEqual({ total: 18, structured: 16, rawFeel: 2 });
    expect(report.rawFeel.find((r) => r.where === "input closed")?.caseTypes).toEqual(["ct_a", "ct_b"]);
    expect(report.presentation.map((p) => p.construct)).toEqual(["attribute namespace"]);
    expect(renderReport(report)).toContain("# Import coverage");
  });

  it("should report a construct the spec cannot hold when a file contains one", () => {
    const xml = sampleDmn("ct_a").replace("<rule ", '<rule extra="1" ');
    const { report } = importDmns([{ name: "wa-task-completion-demo-ct_a.dmn", xml }]);
    expect(report.unrepresentable.map((u) => u.construct)).toEqual(["attribute extra on <rule>"]);
  });

  it("should skip a file that is not named like a task DMN when the directory holds other files", () => {
    const { report } = importDmns([{ name: "notes.dmn", xml: "<definitions/>" }, file("ct_a")]);
    expect(report.notes[0]).toContain("notes.dmn");
    expect(report.files).toHaveLength(1);
  });

  it("should fail when a column is in a different order in different case types", () => {
    const reversed = parseDmn(sampleDmn("ct_b"));
    reversed.decisions[0]?.table?.inputs.reverse();
    for (const rule of reversed.decisions[0]?.table?.rules ?? []) {
      rule.inputs.reverse();
    }
    expect(() => importDmns([file("ct_a"), { name: "wa-task-completion-demo-ct_b.dmn", xml: writeDmn(reversed) }])).toThrow(/different order/);
  });
});

describe("importDmns constructs the generator would change", () => {
  const a = (xml: string) => [{ name: "wa-task-completion-demo-ct_a.dmn", xml }];
  const constructs = (xml: string) => importDmns(a(xml)).report.unrepresentable.map((u) => u.construct);

  it("should report the table's id when no decision has the file's key as its id", () => {
    const xml = sampleDmn("ct_a").replaceAll('"wa-task-completion-demo-ct_a"', '"my_table"');
    expect(constructs(xml)).toEqual(["no decision has the file's key wa-task-completion-demo-ct_a as its id; the table my_table would be renamed to it"]);
  });

  it("should report a variable on the main decision when the file has one", () => {
    const xml = sampleDmn("ct_a").replace("<decisionTable", '<variable id="V" name="v" /><decisionTable');
    expect(constructs(xml)).toEqual(["the main decision Demo completion has a <variable>"]);
  });

  it("should report two helper decisions of one name when a file has them", () => {
    const original = sampleDmn("ct_a");
    const helper = /<decision id="Decision_LATEST"[\s\S]*?<\/decision>/.exec(original)?.[0] as string;
    const xml = original.replace(helper, `${helper}${helper.replace('id="Decision_LATEST"', 'id="Decision_TWO"')}`);
    expect(constructs(xml)).toEqual(["more than one helper decision is named LATEST"]);
  });

  it("should regenerate a helper without a variable as one without a variable when the file has none", () => {
    const xml = sampleDmn("ct_a").replace(/<variable id="InformationItem[^>]*\/>\n/, "");
    const { spec, layout } = importDmns(a(xml));
    expect(spec.decisions.completion?.helpers?.[0]?.variable).toBe(false);
    expect(parseDmn(generateAll(spec, layout)[0]?.xml as string).decisions[1]?.variable).toBeUndefined();
  });

  it("should give the variable back to a case type that has one when another case type lacks it", () => {
    const bare = sampleDmn("ct_b").replace(/<variable id="InformationItem[^>]*\/>\n/, "");
    const { spec, layout } = importDmns([...a(sampleDmn("ct_a")), { name: "wa-task-completion-demo-ct_b.dmn", xml: bare }]);
    const helper = spec.decisions.completion?.helpers?.[0];
    expect(helper?.variable ?? helper?.overrides?.ct_b?.variable ?? helper?.overrides?.ct_a?.variable).toBeDefined();
    const out = generateAll(spec, layout);
    expect(parseDmn(out[0]?.xml as string).decisions[1]?.variable).toBeDefined();
    expect(parseDmn(out[1]?.xml as string).decisions[1]?.variable).toBeUndefined();
  });
});
