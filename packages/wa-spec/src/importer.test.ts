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

describe("importDmns keys and null literals", () => {
  it("should keep a helper whose expression is the null literal as null when it is imported", () => {
    const xml = sampleDmn("ct_a").replace(/(<literalExpression[^>]*>\s*<text>)[^<]*/, "$1null");
    const { spec } = importDmns([{ name: "wa-task-completion-demo-ct_a.dmn", xml }]);
    expect(spec.decisions.completion?.helpers?.[0]?.expression).toBeNull();
  });

  it("should give repeated input keys numbers no other key in the table has when a numbered key already exists", () => {
    const doc = parseDmn(sampleDmn("ct_a"));
    const table = doc.decisions[0]?.table;
    if (!table) {
      throw new Error("no table");
    }
    table.inputs = ["Event Id", "Event Id", "Event Id 2"].map((label) => ({ label, expression: "" }));
    table.rules = [];
    const { spec } = importDmns([{ name: "wa-task-completion-demo-ct_a.dmn", xml: writeDmn(doc) }]);
    expect(spec.decisions.completion?.inputs.map((c) => c.key)).toEqual(["eventId", "eventId3", "eventId2"]);
  });
});

describe("importDmns across kinds, attributes and checks", () => {
  const named = (kind: string, slug: string, caseType: string, xml: string) => ({ name: `wa-task-${kind}-${slug}-${caseType}.dmn`, xml });

  it("should record the case types a kind applies to when a case type has no file of that kind", () => {
    const { spec } = importDmns([
      file("ct_a"),
      file("ct_b"),
      named(
        "cancellation",
        "demo",
        "ct_a",
        sampleDmn("ct_a")
          .replaceAll("wa-completion-definition", "wa-cancellation-definition")
          .replaceAll("wa-task-completion-demo", "wa-task-cancellation-demo")
      )
    ]);
    expect(spec.decisions.completion?.only).toBeUndefined();
    expect(spec.decisions.cancellation?.only).toEqual(["ct_a"]);
    expect(generateAll(spec).map((f) => f.fileName)).toEqual([
      "wa-task-completion-demo-ct_a.dmn",
      "wa-task-completion-demo-ct_b.dmn",
      "wa-task-cancellation-demo-ct_a.dmn"
    ]);
  });

  it("should not count a case type or slug when its file has no decision table", () => {
    const { spec, report } = importDmns([file("ct_a"), named("completion", "other", "ct_z", "<definitions/>")]);
    expect(spec.caseTypes.map((c) => c.id)).toEqual(["ct_a"]);
    expect(spec.service.slug).toBe("demo");
    expect(report.notes.join()).toContain("no decision table found");
  });

  it("should keep the modeler attributes and namespace of the root element when the file has them", () => {
    const xml = sampleDmn("ct_a")
      .replace("<definitions ", '<definitions xmlns:modeler="http://camunda.org/schema/modeler/1.0" ')
      .replace('exporterVersion="5.50.1"', 'exporterVersion="5.50.1" modeler:executionPlatform="Camunda Platform" modeler:executionPlatformVersion="7.17.0"');
    const { spec, layout, report } = importDmns([{ name: "wa-task-completion-demo-ct_a.dmn", xml }]);
    expect(report.unrepresentable).toEqual([]);
    const out = generateAll(spec, layout)[0]?.xml ?? "";
    expect(out).toContain('modeler:executionPlatform="Camunda Platform" modeler:executionPlatformVersion="7.17.0"');
    expect(out).toContain('xmlns:modeler="http://camunda.org/schema/modeler/1.0"');
    expect(generateAll(spec)[0]?.xml).not.toContain("modeler:");
  });

  it("should carry a helper's variable name and its absence per case type when they differ from the helper's name", () => {
    const renamed = sampleDmn("ct_a").replace(
      '<variable id="InformationItem_wa-completion-definition-ct_a_Decision_LATEST" name="LATEST"',
      '<variable id="V1" name="latest"'
    );
    expect(renamed).toContain('name="latest"');
    const { spec, layout, report } = importDmns([{ name: "wa-task-completion-demo-ct_a.dmn", xml: renamed }, file("ct_b")]);
    expect(report.unrepresentable).toEqual([]);
    const out = generateAll(spec, layout);
    expect(parseDmn(out[0]?.xml ?? "").decisions[1]?.variable?.name).toBe("latest");
    expect(parseDmn(out[1]?.xml ?? "").decisions[1]?.variable?.name).toBe("LATEST");
    expect(generateAll(spec).map((f) => parseDmn(f.xml).decisions[1]?.variable?.name)).toEqual(["latest", "LATEST"]);
  });

  it("should say which output is duplicated when a table has two outputs of one name", () => {
    const doc = parseDmn(sampleDmn("ct_a"));
    const outputs = doc.decisions[0]?.table?.outputs;
    outputs?.push({ name: "taskType" });
    for (const rule of doc.decisions[0]?.table?.rules ?? []) {
      rule.outputs.push("");
    }
    expect(() => importDmns([{ name: "wa-task-completion-demo-ct_a.dmn", xml: writeDmn(doc) }])).toThrow(/duplicate output name taskType/);
  });

  it("should refuse to return a spec that does not validate when the files name a service that cannot be an id", () => {
    expect(() => importDmns([{ name: "wa-task-completion-my svc-ct_a.dmn", xml: sampleDmn("ct_a") }])).toThrow(/invalid spec[\s\S]*service slug my svc/);
  });
});

describe("importDmns refusals and allowed values", () => {
  const dmn = (kind: string, slug: string, caseType: string) => ({
    name: `wa-task-${kind}-${slug}-${caseType}.dmn`,
    xml: sampleDmn(caseType)
  });

  it("should throw and name the files when they belong to more than one service", () => {
    expect(() => importDmns([dmn("completion", "one", "ct_a"), dmn("completion", "two", "ct_b")])).toThrow(
      /more than one service[\s\S]*one: wa-task-completion-one-ct_a\.dmn[\s\S]*two: wa-task-completion-two-ct_b\.dmn/
    );
  });

  it("should throw and name both files when a kind and case type have two files", () => {
    expect(() => importDmns([dmn("completion", "one", "ct_a"), dmn("completion", "two", "ct_a")])).toThrow(
      /wa-task-completion-one-ct_a\.dmn and wa-task-completion-two-ct_a\.dmn are both the completion DMN of ct_a/
    );
  });

  it("should report a helper named table as unrepresentable when a file has one", () => {
    const xml = sampleDmn("ct_a").replaceAll('name="LATEST"', 'name="table"');
    const { report } = importDmns([{ name: "wa-task-completion-demo-ct_a.dmn", xml }]);
    expect(report.unrepresentable.map((u) => u.construct)).toEqual(["a helper decision named table, which the spec reserves for the main decision"]);
  });

  it("should carry a column's allowed values with an override per case type and write them back when the DMNs have them", () => {
    const withValues = (caseType: string, text?: string) =>
      sampleDmn(caseType).replace(
        "</inputExpression>",
        text === undefined ? "</inputExpression>" : `</inputExpression><inputValues id="IV_${caseType}"><text>${text}</text></inputValues>`
      );
    const { spec, layout, report } = importDmns([
      { name: "wa-task-completion-demo-ct_a.dmn", xml: withValues("ct_a", '"a","b"') },
      { name: "wa-task-completion-demo-ct_b.dmn", xml: withValues("ct_b", '"a","b"') },
      { name: "wa-task-completion-demo-ct_c.dmn", xml: withValues("ct_c") }
    ]);
    expect(report.unrepresentable).toEqual([]);
    expect(spec.decisions.completion?.inputs[0]?.allowedValues).toBe('"a","b"');
    expect(spec.decisions.completion?.inputs[0]?.overrides?.ct_c?.allowedValues).toBeNull();
    const out = generateAll(spec, layout);
    expect(parseDmn(out[0]?.xml ?? "").decisions[0]?.table?.inputs[0]).toMatchObject({ allowedValues: '"a","b"', allowedValuesId: "IV_ct_a" });
    expect(parseDmn(out[2]?.xml ?? "").decisions[0]?.table?.inputs[0]?.allowedValues).toBeUndefined();
    expect(parseDmn(generateAll(spec)[1]?.xml ?? "").decisions[0]?.table?.inputs[0]?.allowedValues).toBe('"a","b"');
  });
});
