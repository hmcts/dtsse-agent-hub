import { describe, expect, it } from "vitest";
import { sampleDmn } from "./__fixtures__/dmn.ts";
import { parseDmn } from "./dmn-model.ts";
import { decisionKey, generateAll, generateDocument } from "./generator.ts";
import { importDmns } from "./importer.ts";
import { type Spec, Spec as SpecSchema } from "./schema.ts";

const spec: Spec = SpecSchema.parse({
  version: 1,
  service: { slug: "demo" },
  caseTypes: [{ id: "ct_a" }, { id: "ct_b" }],
  decisions: {
    completion: {
      name: "Demo completion",
      hitPolicy: "COLLECT",
      historyTimeToLive: "P30D",
      overrides: { ct_b: { name: "Demo B", hitPolicy: "FIRST", historyTimeToLive: null } },
      inputs: [
        {
          key: "event",
          label: "Event ID",
          variable: "eventId",
          typeRef: "string",
          expression: { field: "eventId" },
          overrides: { ct_b: { typeRef: null, label: "Event" } }
        },
        { key: "extra", label: "Extra", typeRef: "string", expression: "x", only: ["ct_a"] }
      ],
      outputs: [
        { name: "taskType", label: "Task Type", typeRef: "string" },
        { name: "mode", only: ["ct_a"] }
      ],
      rows: [
        { when: { event: { in: ["a", "b"] }, extra: { notIn: ["z"] } }, returns: { taskType: "T1", mode: "Auto" }, only: ["ct_a"] },
        {
          description: "both",
          when: { event: { in: ["c"] } },
          returns: { taskType: { if: { field: "k", op: "exists" }, use: { field: "k" }, otherwise: "none" } }
        }
      ],
      helpers: [{ name: "H", typeRef: "string", expression: { feel: "now()" }, overrides: { ct_b: { expression: 7 } } }],
      dependencies: [{ decision: "table", requires: "H", only: ["ct_a"] }]
    }
  }
});

describe("generateDocument", () => {
  it("should name the decision after the service, kind and case type when generating", () => {
    expect(decisionKey(spec, "completion", "ct_a")).toBe("wa-task-completion-demo-ct_a");
    expect(generateDocument(spec, "completion", "ct_a")?.decisions[0]?.id).toBe("wa-task-completion-demo-ct_a");
  });

  it("should apply overrides and drop scoped columns and rows when generating for the second case type", () => {
    const b = generateDocument(spec, "completion", "ct_b")?.decisions[0];
    expect(b?.name).toBe("Demo B");
    expect(b?.historyTimeToLive).toBeUndefined();
    expect(b?.table?.hitPolicy).toBe("FIRST");
    expect(b?.table?.inputs).toEqual([{ label: "Event", inputVariable: "eventId", expression: "eventId" }]);
    expect(b?.table?.outputs.map((o) => o.name)).toEqual(["taskType"]);
    expect(b?.table?.rules).toEqual([{ description: "both", inputs: ['"c"'], outputs: ['if (k != null) then k else "none"'] }]);
    expect(b?.requires).toEqual([]);
  });

  it("should render each column, entry and helper in document order when generating for the first case type", () => {
    const a = generateDocument(spec, "completion", "ct_a");
    const table = a?.decisions[0]?.table;
    expect(table?.inputs.map((i) => i.label)).toEqual(["Event ID", "Extra"]);
    expect(table?.rules[0]).toEqual({ inputs: ['"a", "b"', 'not("z")'], outputs: ['"T1"', '"Auto"'] });
    expect(a?.decisions[0]?.requires).toEqual(["Decision_H"]);
    expect(a?.decisions[1]).toMatchObject({ name: "H", variable: { name: "H", typeRef: "string" }, literal: { text: "now()" } });
    expect(generateDocument(spec, "completion", "ct_b")?.decisions).toHaveLength(2);
    expect(generateDocument(spec, "completion", "ct_b")?.decisions[1]?.literal?.text).toBe("7");
  });

  it("should return nothing when the kind is not in the spec or the case type is unknown", () => {
    expect(generateDocument(spec, "initiation", "ct_a")).toBeUndefined();
    expect(generateDocument(spec, "completion", "ct_z")).toBeUndefined();
  });
});

describe("generateAll", () => {
  it("should produce one parseable DMN per kind and case type when the spec defines a kind", () => {
    const files = generateAll(spec);
    expect(files.map((f) => f.fileName)).toEqual(["wa-task-completion-demo-ct_a.dmn", "wa-task-completion-demo-ct_b.dmn"]);
    for (const file of files) {
      expect(parseDmn(file.xml).decisions.length).toBeGreaterThan(0);
    }
  });

  it("should regenerate the imported DMNs when the spec came from them", () => {
    const { spec: imported } = importDmns([
      { name: "wa-task-completion-demo-ct_a.dmn", xml: sampleDmn("ct_a") },
      { name: "wa-task-completion-demo-ct_b.dmn", xml: sampleDmn("ct_b", { extraRule: true }) }
    ]);
    const regenerated = generateAll(imported);
    expect(parseDmn(regenerated[1]?.xml ?? "").decisions[0]?.table?.rules).toEqual(parseDmn(sampleDmn("ct_b", { extraRule: true })).decisions[0]?.table?.rules);
  });
});
