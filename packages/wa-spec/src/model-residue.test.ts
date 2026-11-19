import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileModel } from "./model-compile.ts";
import { loadSpecFile, modelLayoutPath, orderPathFor, parseModel, stringifyModel, stringifyOrdering } from "./model-io.ts";
import { liftSpec, renderLiftReport } from "./model-lift.ts";
import type { Kind, Row, Spec } from "./schema.ts";
import { stringifySpec } from "./spec-io.ts";

const MODEL = `
kind: wa-model
version: 1
service: {slug: demo, jurisdiction: DEMO}
caseTypes: [{id: ct_a}, {id: ct_b}]
roles:
  admin: {}
tasks:
  - id: Vetting
    name: Vetting
    workType: routine_work
    permissions: {profile: p}
    create: [{event: submit}]
    complete: [{event: vetted}]
cancellations:
  - {events: gone, action: Cancel}
permissionProfiles:
  p:
    admin: {perms: [Read]}
`;

const base = (): Spec => compileModel(parseModel(MODEL));

describe("lifting rows that are not about one task", () => {
  const reasons: Array<[Kind, Row, string]> = [
    ["initiation", { when: {}, returns: { taskId: "T" } }, "it has no event"],
    [
      "configuration",
      { when: { taskType: { in: ["not a name"] } }, returns: { name: "a", value: "b", canReconfigure: false } },
      "its taskType is not a plain list of task ids"
    ],
    [
      "configuration",
      { when: { caseData: { in: ["x"] } }, returns: { name: "a", value: "b", canReconfigure: false } },
      "it has conditions beyond the task type"
    ],
    ["configuration", { returns: { name: "a", value: "b" } }, "it is not an attribute name, a value and a reconfigure flag"],
    ["permissions", { when: { taskType: { in: ["not a name"] } }, returns: { name: "admin", value: "Read" } }, "its taskType is not a plain list of task ids"],
    ["permissions", { when: { case: { in: ["x"] } }, returns: { name: "admin", value: "Read" } }, "it has conditions beyond the task type"],
    ["permissions", { returns: { name: "admin", value: 3 } }, "its permissions are not a plain list"],
    ["completion", { when: {}, returns: { taskType: "Vetting" } }, "it has no event, or conditions beyond it"],
    ["task-types", { returns: { taskTypeId: "T" } }, "it is not a task type and its name"],
    ["cancellation", { when: { state: { in: ["s"] } }, returns: { action: "Cancel" } }, "it is not an event, an action and optionally a category"],
    [
      "initiation",
      { only: ["ct_b", "ct_a"], when: { eventId: { in: ["e"] } }, returns: { taskId: "T" } },
      "its case types are not a proper subset in the spec's case type order"
    ]
  ];

  it.each(reasons)("should keep a %s row in the tables and compile back equal when %j", (kind, row, reason) => {
    const spec = base();
    const decision = spec.decisions[kind] ?? structuredClone(spec.decisions.initiation);
    if (decision === undefined) {
      throw new Error("no decision");
    }
    spec.decisions[kind] = { ...decision, rows: [...decision.rows, row] };
    const result = liftSpec(spec);
    expect(result.report.residue.map((r) => r.reason)).toContain(reason);
    expect(result.report.differences).toEqual([]);
  });

  it("should say which differences remain in the report when the model does not compile back", () => {
    const { report } = liftSpec(base());
    const text = renderLiftReport({ ...report, differences: ["a differs", "b differs"] }, "Demo");
    expect(text).toContain("- a differs");
    expect(text).toContain("- b differs");
  });
});

describe("carrying decision case types and helper variables through the residue", () => {
  it("should compile back equal when a decision applies to some case types and a helper names its own variable", () => {
    const spec = base();
    const initiation = spec.decisions.initiation;
    if (initiation === undefined) {
      throw new Error("no initiation");
    }
    spec.decisions.initiation = {
      ...initiation,
      only: ["ct_a"],
      helpers: [
        { name: "latest", variable: "latestTitle", expression: "x", overrides: { ct_b: { variable: false } } },
        { name: "quiet", variable: false, expression: "y", only: ["ct_a"] }
      ],
      dependencies: [{ decision: "table", requires: "latest" }]
    };
    const result = liftSpec(spec);
    expect(result.report.differences).toEqual([]);
    expect(result.model.tables?.initiation?.only).toEqual(["ct_a"]);
    expect(result.model.tables?.initiation?.helpers?.[0]?.variable).toBe("latestTitle");
    expect(result.model.tables?.initiation?.helpers?.[1]?.variable).toBe(false);
    expect(compileModel(result.model, result.ordering).decisions.initiation?.helpers).toEqual(spec.decisions.initiation.helpers);
  });
});

describe("loading a model with a layout of its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-spec-model-io-"));

  it("should read the layout the model names and the one given on the command line when loading", () => {
    const lifted = liftSpec(base(), { layout: "named.layout.yaml", order: "m.order.yaml" });
    writeFileSync(join(dir, "m.yaml"), stringifyModel(lifted.model));
    writeFileSync(join(dir, "m.order.yaml"), stringifyOrdering(lifted.ordering));
    writeFileSync(join(dir, "named.layout.yaml"), "version: 1\nfiles: {}\n");
    writeFileSync(join(dir, "other.layout.yaml"), "version: 1\nfiles: {}\n");
    const model = parseModel(stringifyModel(lifted.model));
    expect(modelLayoutPath(join(dir, "m.yaml"), model)).toBe(join(dir, "named.layout.yaml"));
    expect(orderPathFor(join(dir, "missing.yaml"), { ...model, order: undefined })).toBeUndefined();
    expect(loadSpecFile(join(dir, "m.yaml")).layoutPath).toBe(join(dir, "named.layout.yaml"));
    expect(loadSpecFile(join(dir, "m.yaml"), join(dir, "other.layout.yaml")).layoutPath).toBe(join(dir, "other.layout.yaml"));
  });

  it("should read the layout beside a spec when loading it, and none when there is none", () => {
    writeFileSync(join(dir, "s.yaml"), stringifySpec(base()));
    expect(loadSpecFile(join(dir, "s.yaml")).layout).toBeUndefined();
    writeFileSync(join(dir, "s.layout.yaml"), "version: 1\nfiles: {}\n");
    expect(loadSpecFile(join(dir, "s.yaml")).layoutPath).toBe(join(dir, "s.layout.yaml"));
  });

  it("should reject a model whose references are broken when parsing it", () => {
    expect(() => parseModel(MODEL.replace("profile: p", "profile: nope"))).toThrow("Invalid model");
  });
});

describe("lifting default grants", () => {
  it("should keep permissions as rows when a default grant covers only some case types", () => {
    const spec = base();
    const permissions = spec.decisions.permissions;
    if (permissions === undefined) {
      throw new Error("no permissions");
    }
    permissions.rows.push({ only: ["ct_a"], returns: { name: "supervisor", value: "Read" } });
    const result = liftSpec(spec);
    expect(result.report.counts.permissions.lifted).toBe(0);
    expect(result.report.residue.some((r) => r.reason.includes("default grant of supervisor"))).toBe(true);
    expect(result.report.differences).toEqual([]);
  });

  it("should keep permissions as rows when a role has two default grants", () => {
    const spec = base();
    const permissions = spec.decisions.permissions;
    if (permissions === undefined) {
      throw new Error("no permissions");
    }
    permissions.rows.push({ returns: { name: "supervisor", value: "Read" } }, { returns: { name: "supervisor", value: "Own" } });
    const result = liftSpec(spec);
    expect(result.report.differences).toEqual([]);
    expect(result.report.counts.permissions.lifted).toBe(0);
  });
});
