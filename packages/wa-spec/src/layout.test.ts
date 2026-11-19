import { describe, expect, it } from "vitest";
import { parseDmn, sampleDmn } from "./__fixtures__/dmn.ts";
import { writeDmn } from "./dmn-model.ts";
import { generateAll, generateDocument } from "./generator.ts";
import { importDmns } from "./importer.ts";
import { applyLayout } from "./layout.ts";
import { parseLayout, parseSpec, stringifyLayout, stringifySpec } from "./spec-io.ts";

const files = [
  { name: "wa-task-completion-demo-ct_a.dmn", xml: sampleDmn("ct_a") },
  { name: "wa-task-completion-demo-ct_b.dmn", xml: sampleDmn("ct_b", { extraRule: true }) }
];

const fileA = files[0] as (typeof files)[number];

/** A file as Camunda Modeler would leave it: random ids, a column width and a diagram that interleaves edges and shapes. */
const handMade = fileA.xml
  .replaceAll(
    / id="((?:Input|InputExpression|Output|DecisionTable|InputEntry|OutputEntry|DMNShape|DMNEdge|DMNDiagram|Rule)_[^"]*)"/g,
    (_all, id: string) => ` id="X${Buffer.from(id).toString("hex").slice(-12)}"`
  )
  .replace("<input ", '<input biodi:width="321" ');

describe("layout", () => {
  it("should regenerate each file exactly when it was imported with its layout", () => {
    const { spec, layout } = importDmns(files);
    const regenerated = generateAll(parseSpec(stringifySpec(spec)), parseLayout(stringifyLayout(layout)));
    expect(regenerated.map((f) => f.xml)).toEqual(files.map((f) => f.xml));
  });

  it("should reproduce the ids, widths and diagram of a hand-made file when the layout is applied", () => {
    const { spec, layout } = importDmns([{ name: fileA.name, xml: handMade }]);
    const out = generateAll(spec, layout)[0]?.xml as string;
    expect(parseDmn(out)).toEqual(parseDmn(handMade));
    expect(out).toContain('biodi:width="321"');
  });

  it("should generate ids that differ from the stored ones only for the rows the spec added when rows are added and reordered", () => {
    const { spec, layout } = importDmns([fileA]);
    const completion = spec.decisions.completion;
    if (!completion) {
      throw new Error("no completion decision");
    }
    const [first, second] = completion.rows;
    completion.rows = [second, { when: { eventId: { in: ["new"] } }, returns: { taskType: "N" } }, first] as typeof completion.rows;
    const original = parseDmn(fileA.xml).decisions[0]?.table?.rules ?? [];
    const rules = parseDmn(generateAll(spec, layout)[0]?.xml as string).decisions[0]?.table?.rules ?? [];
    expect(rules.map((r) => r.id)).toEqual([original[1]?.id, expect.stringMatching(/^Rule_/), original[0]?.id]);
    expect(rules[0]?.inputIds).toEqual(original[1]?.inputIds);
    expect(new Set(rules.flatMap((r) => [r.id, ...(r.inputIds ?? []), ...(r.outputIds ?? [])])).size).toBe(rules.length * 5);
  });

  it("should add shapes and edges for a decision and requirement the layout lacks when the spec gained a helper", () => {
    const { spec, layout } = importDmns([fileA]);
    const completion = spec.decisions.completion;
    completion?.helpers?.push({ name: "EXTRA", expression: 1 });
    completion?.dependencies?.push({ decision: "table", requires: "EXTRA" });
    const doc = parseDmn(generateAll(spec, layout)[0]?.xml as string);
    expect(doc.decisions.map((d) => d.name)).toEqual(["Demo completion", "LATEST", "EXTRA"]);
    expect(doc.diagram?.items.filter((i) => i.type === "shape")).toHaveLength(3);
    expect(doc.diagram?.items.filter((i) => i.type === "edge")).toHaveLength(2);
  });

  it("should drop a stored text when the spec no longer renders to it", () => {
    const { spec, layout } = importDmns([{ name: fileA.name, xml: fileA.xml.replace('<text>"submit", "update"</text>', '<text>"submit",\n"update"</text>') }]);
    expect(generateAll(spec, layout)[0]?.xml).toContain('"submit",\n"update"');
    const first = spec.decisions.completion?.rows[0];
    if (first?.when) {
      first.when.eventId = { in: ["changed"] };
    }
    expect(generateAll(spec, layout)[0]?.xml).not.toContain('"submit",\n"update"');
  });

  it("should leave the document as generated when there is no layout for it", () => {
    const { spec } = importDmns(files);
    const bare = generateDocument(spec, "completion", "ct_a");
    expect(applyLayout(bare as NonNullable<typeof bare>, undefined, [])).toBe(bare);
  });

  it("should keep the layout of a different file untouched when asked about a case type it lacks", () => {
    const { spec, layout } = importDmns(files);
    const withoutB = { ...layout, files: { "completion/ct_a": layout.files["completion/ct_a"] as NonNullable<(typeof layout.files)[string]> } };
    const doc = generateDocument(spec, "completion", "ct_b", withoutB);
    expect(doc?.decisions[0]?.table?.rules[0]?.id).toBeUndefined();
  });

  it("should record the namespaces and exporter version when the file declares them", () => {
    const xml = fileA.xml.replace('exporterVersion="5.50.1"', 'exporterVersion="5.36.1"');
    const { layout } = importDmns([{ name: fileA.name, xml }]);
    expect(layout.files["completion/ct_a"]?.exporterVersion).toBe("5.36.1");
    expect(layout.files["completion/ct_a"]?.namespaces?.[0]).toMatch(/^xmlns /);
  });
});

describe("layout when the spec's columns change", () => {
  it("should keep the rule and entry ids of the existing columns when an input column is added", () => {
    const { spec, layout } = importDmns([fileA]);
    const completion = spec.decisions.completion;
    if (!completion) {
      throw new Error("no completion decision");
    }
    completion.inputs.splice(1, 0, { key: "added", expression: { field: "x" } });
    const original = parseDmn(fileA.xml).decisions[0]?.table;
    const table = parseDmn(generateAll(spec, layout)[0]?.xml as string).decisions[0]?.table;
    expect(table?.inputs).toHaveLength(3);
    expect(table?.rules.map((r) => r.id)).toEqual(original?.rules.map((r) => r.id));
    expect(table?.rules[0]?.inputIds?.[0]).toBe(original?.rules[0]?.inputIds?.[0]);
    expect(table?.rules[0]?.inputIds?.[2]).toBe(original?.rules[0]?.inputIds?.[1]);
    expect(table?.rules[0]?.inputIds?.[1]).toMatch(/^InputEntry_/);
    expect(table?.rules[0]?.outputIds).toEqual(original?.rules[0]?.outputIds);
  });
});

describe("layout column ids", () => {
  it("should keep each entry id with its column when a column key is an integer", () => {
    const doc = parseDmn(fileA.xml);
    const table = doc.decisions[0]?.table;
    if (!table) {
      throw new Error("no table");
    }
    table.inputs = [
      { label: "Foo", expression: "", id: "In_foo", expressionId: "Ex_foo" },
      { label: "2", expression: "", id: "In_two", expressionId: "Ex_two" }
    ];
    table.rules = [{ id: "R1", inputIds: ["E_foo", "E_two"], inputs: ['"a"', '"b"'], outputIds: ["O1", "O2"], outputs: ['"x"', '"y"'] }];
    const xml = writeDmn({ ...doc, decisions: [{ ...(doc.decisions[0] as NonNullable<(typeof doc.decisions)[0]>) }] });
    const { spec, layout } = importDmns([{ name: fileA.name, xml }]);
    expect(spec.decisions.completion?.inputs.map((c) => c.key)).toEqual(["foo", "2"]);
    const rule = parseDmn(generateAll(spec, layout)[0]?.xml as string).decisions[0]?.table;
    expect(rule?.inputs.map((i) => i.id)).toEqual(["In_foo", "In_two"]);
    expect(rule?.rules[0]?.inputIds).toEqual(["E_foo", "E_two"]);
  });
});

describe("layout when a column and a row are added together", () => {
  it("should keep every original rule id when an input column and a row are added to a spec", () => {
    const { spec, layout } = importDmns([fileA]);
    const completion = spec.decisions.completion;
    if (!completion) {
      throw new Error("no completion decision");
    }
    completion.inputs.splice(1, 0, { key: "added", expression: { field: "x" } });
    completion.rows.splice(1, 0, { when: { eventId: { in: ["brand-new"] } }, returns: { taskType: "N" } });
    const original = parseDmn(fileA.xml).decisions[0]?.table?.rules.map((r) => r.id) ?? [];
    const rules = parseDmn(generateAll(spec, layout)[0]?.xml as string).decisions[0]?.table?.rules.map((r) => r.id) ?? [];
    expect(rules).toHaveLength(original.length + 1);
    expect(rules.filter((id) => original.includes(id as string))).toEqual(original);
  });
});
