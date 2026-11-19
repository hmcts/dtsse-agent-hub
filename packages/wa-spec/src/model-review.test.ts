import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Model } from "./model.ts";
import { compileModel } from "./model-compile.ts";
import { loadSpecFile, parseModel, stringifyModel, stringifyOrdering } from "./model-io.ts";
import { liftSpec } from "./model-lift.ts";
import type { Row } from "./schema.ts";
import { compareSpecs } from "./spec-diff.ts";
import { stringifySpec } from "./spec-io.ts";

const BASE = `
kind: wa-model
version: 1
service: {slug: demo}
caseTypes: [{id: ct_a}, {id: ct_b}, {id: ct_c}]
roles: {admin: {}}
tasks:
  - id: A
    name: A
    only: [ct_a, ct_b]
    workType: w1
    roleCategory: r1
    attributes: {custom: [{value: 1, only: [ct_a]}, {value: 2, only: [ct_b]}]}
    complete: [{event: done}]
cancellations:
  - {events: gone, action: Cancel, categories: [X, Y]}
  - {events: moved, action: Reconfigure}
`;

const configRows = (model: Model, ordering?: Parameters<typeof compileModel>[1]): Row[] => compileModel(model, ordering).decisions.configuration?.rows ?? [];
const tasksOf = (row: Row): string[] => (row.when?.taskType as { in: string[] } | undefined)?.in ?? [];

describe("validateModel scopes", () => {
  it("should name a case type that is unknown in a value entry's only or overrides when validating", () => {
    const text = `${BASE}`.replace("workType: w1", "workType: {value: w1, only: [ct_zz], overrides: {ct_yy: w2}}");
    expect(() => parseModel(text)).toThrow(/task A workType: unknown case type ct_zz[\s\S]*task A workType overrides: unknown case type ct_yy/);
  });

  it("should reject an unknown case type in a completion override and in an attribute entry when validating", () => {
    const text = BASE.replace("complete: [{event: done}]", "complete: [{event: done, overrides: {ct_q: null}}]").replace(
      "{value: 2, only: [ct_b]}",
      "{value: 2, only: [ct_p]}"
    );
    expect(() => parseModel(text)).toThrow(/complete overrides: unknown case type ct_q[\s\S]*attributes.custom: unknown case type ct_p/);
  });

  it("should reject an entry scoped to a case type the task does not have when validating", () => {
    const text = BASE.replace("{value: 2, only: [ct_b]}", "{value: 2, only: [ct_c]}");
    expect(() => parseModel(text)).toThrow("task A attributes.custom: ct_c is not one of the task's case types");
  });
});

describe("loading", () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-spec-review-"));

  it("should fail when a model names an ordering file that does not exist", () => {
    writeFileSync(join(dir, "m.yaml"), `${BASE}order: gone.order.yaml\n`);
    expect(() => loadSpecFile(join(dir, "m.yaml"))).toThrow("names the ordering file gone.order.yaml, which does not exist");
  });

  it("should compile without ordering when no ordering file is named and none sits beside the model", () => {
    writeFileSync(join(dir, "n.yaml"), BASE);
    expect(loadSpecFile(join(dir, "n.yaml")).spec.decisions.initiation).toBeUndefined();
  });

  it("should fail when an explicit layout file does not exist, for a model and for a spec", () => {
    writeFileSync(join(dir, "n.yaml"), BASE);
    expect(() => loadSpecFile(join(dir, "n.yaml"), join(dir, "none.layout.yaml"))).toThrow("does not exist");
    writeFileSync(join(dir, "s.yaml"), stringifySpec(compileModel(parseModel(BASE))));
    expect(() => loadSpecFile(join(dir, "s.yaml"), join(dir, "none.layout.yaml"))).toThrow("does not exist");
    expect(loadSpecFile(join(dir, "s.yaml")).layout).toBeUndefined();
  });

  it("should fail when a model's own layout field names a file that does not exist", () => {
    writeFileSync(join(dir, "l.yaml"), `${BASE}layout: missing.layout.yaml\n`);
    expect(() => loadSpecFile(join(dir, "l.yaml"))).toThrow("missing.layout.yaml does not exist");
  });
});

describe("compiling without an ordering file", () => {
  it("should keep a task's rows in order when a later attribute matches an earlier row", () => {
    const model = parseModel(`
kind: wa-model
version: 1
service: {slug: demo}
caseTypes: [{id: ct_a}]
tasks:
  - {id: A, workType: w1, roleCategory: r1}
  - {id: B, workType: w2, roleCategory: r1}
`);
    const rows = configRows(model);
    const names = (task: string) =>
      rows
        .map((r, i) => ({ i, name: r.returns?.name, has: tasksOf(r).includes(task) }))
        .filter((r) => r.has)
        .map((r) => r.name);
    expect(names("B")).toEqual(["workType", "roleCategory"]);
    expect(rows.findIndex((r) => tasksOf(r).includes("B") && r.returns?.name === "workType")).toBeLessThan(
      rows.findIndex((r) => tasksOf(r).includes("B") && r.returns?.name === "roleCategory")
    );
  });

  it("should still share a row between tasks when joining it moves no task's rows out of order", () => {
    const model = parseModel(`
kind: wa-model
version: 1
service: {slug: demo}
caseTypes: [{id: ct_a}]
tasks:
  - {id: A, workType: w1}
  - {id: B, workType: w1}
`);
    expect(configRows(model).map(tasksOf)).toEqual([["A", "B"]]);
  });
});

describe("ordering references", () => {
  const lifted = liftSpec(compileModel(parseModel(BASE)));
  const model = parseModel(stringifyModel(lifted.model));

  it("should keep the rows of existing cancellation rules in place when a rule is inserted before them", () => {
    const before = compileModel(model, lifted.ordering).decisions.cancellation?.rows ?? [];
    const inserted = { ...model, cancellations: [{ events: "new", action: "Cancel" }, ...(model.cancellations ?? [])] } as Model;
    const after = compileModel(inserted, lifted.ordering).decisions.cancellation?.rows ?? [];
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.at(-1)?.when).toEqual({ event: { in: ["new"] } });
  });

  it("should keep the rows of repeated slots in place when an entry is inserted before them", () => {
    const task = model.tasks[0] as Model["tasks"][number];
    const entries = task.attributes?.custom as unknown[];
    const edited = { ...model, tasks: [{ ...task, attributes: { custom: [{ value: 0, only: ["ct_b"] }, ...entries] } }] } as Model;
    const before = configRows(model, lifted.ordering)
      .filter((r) => r.returns?.name === "custom")
      .map((r) => r.returns?.value);
    const after = configRows(edited, lifted.ordering)
      .filter((r) => r.returns?.name === "custom")
      .map((r) => r.returns?.value);
    expect(before).toEqual([1, 2]);
    expect(after).toEqual([1, 2, 0]);
  });

  it("should name each cancellation rule by an id the lift writes when lifting", () => {
    expect((lifted.model.cancellations ?? []).map((r) => r.id)).toEqual(["Cancel-gone", "Reconfigure-moved"]);
    expect(stringifyOrdering(lifted.ordering)).toContain("!/Cancel-gone#");
  });
});

describe("compareSpecs", () => {
  it("should report the true number of differences when more than the shown limit differ", () => {
    const a = compileModel(parseModel(BASE));
    const b = structuredClone(a);
    const rows = a.decisions.completion?.rows as Row[];
    const otherRows = b.decisions.completion?.rows as Row[];
    for (let i = 0; i < 45; i++) {
      rows.push({ returns: { taskType: `T${i}` } });
      otherRows.push({ returns: { taskType: `U${i}` } });
    }
    const { differences, total } = compareSpecs(a, b);
    expect(total).toBe(45);
    expect(differences).toHaveLength(40);
  });
});
