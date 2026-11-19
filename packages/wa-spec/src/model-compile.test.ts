import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BASE, configRows, et, rowsOf, small, taskCell, tasksOf, VARIED } from "./__fixtures__/model.ts";
import { importDmns } from "./importer.ts";
import { byCodePoint } from "./merge.ts";
import { linkText, type Model, parseLinkText, validateModel } from "./model.ts";
import { compileModel } from "./model-compile.ts";
import { parseModel, stringifyModel } from "./model-io.ts";
import { liftSpec } from "./model-lift.ts";
import type { Row } from "./schema.ts";
import { diffSpecs } from "./spec-diff.ts";

describe("compileModel", () => {
  it("should share one configuration row across tasks when they have the same value", () => {
    const rows = rowsOf(small(), "configuration").filter((r) => r.returns?.name === "workType");
    expect(rows).toHaveLength(1);
    expect(taskCell(rows[0] as Row)).toEqual(["Vetting", "Review"]);
    expect(rows[0]?.returns).toEqual({ name: "workType", value: "routine_work", canReconfigure: true });
  });

  it("should turn the reconfigure list into the canReconfigure flag when compiling", () => {
    const withFlag = compileModel({ ...small(), tasks: small().tasks.map((t) => (t.id === "Vetting" ? t : { ...t, reconfigure: undefined })) });
    expect(withFlag.decisions.configuration?.rows.filter((r) => r.returns?.name === "workType").map((r) => r.returns?.canReconfigure)).toEqual([true, false]);
  });

  it("should write the link as the task description when compiling a task with a link", () => {
    const row = rowsOf(small(), "configuration").find((r) => r.returns?.name === "description");
    expect(row?.returns?.value).toBe(linkText({ label: "Vet", event: "vet", page: "vet1" }));
    expect(parseLinkText(row?.returns?.value as string)).toEqual({ label: "Vet", event: "vet", page: "vet1" });
  });

  it("should expand a profile into one permissions row per role with the role's category when compiling", () => {
    const rows = rowsOf(small(), "permissions");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.returns).toEqual({ name: "admin", value: "Read, Own", roleCategory: "ADMIN", assignmentPriority: 2, autoAssignable: true });
    expect(taskCell(rows[0] as Row)).toEqual(["Vetting", "Review"]);
    expect(rows[1]?.returns).toMatchObject({ name: "leader", roleCategory: "ADMIN", autoAssignable: false });
  });

  it("should put a cancellation rule's categories on consecutive rows when compiling", () => {
    const rows = rowsOf(small(), "cancellation");
    expect(rows.map((r) => r.returns?.processCategories)).toEqual(["Vetting", "Review", undefined]);
    expect(rows[0]?.when).toEqual({ event: { in: ["dispose", "close"] } });
    expect(rows[2]?.returns).toEqual({ action: "Reconfigure" });
  });

  it("should use the standard columns when the model defines no tables", () => {
    const spec = compileModel(small());
    expect(spec.decisions.permissions?.hitPolicy).toBe("RULE ORDER");
    expect(spec.decisions.initiation?.inputs.map((c) => c.key)).toEqual(["eventId", "postEventState"]);
    expect(rowsOf(small(), "initiation")[1]?.when).toEqual({ eventId: { in: ["review", "rereview"] } });
  });

  it("should reject a model that names an unknown profile or case type when compiling", () => {
    const broken = { ...small(), tasks: [{ id: "X", permissions: "nope", only: ["ct_z"] }] };
    expect(() => compileModel(broken)).toThrow(/unknown permission profile nope/);
    expect(() => compileModel(broken)).toThrow(/unknown case type ct_z/);
    expect(validateModel({ ...small(), tasks: [...small().tasks, small().tasks[0] as Model["tasks"][number]] })).toContain("task Vetting: defined twice");
  });
});

describe("liftSpec and compileModel on ET", () => {
  const lifted = et();

  it("should add the new task to the existing rows and append its trigger when a task is added", () => {
    const added = {
      ...lifted.model,
      tasks: [
        ...lifted.model.tasks,
        {
          id: "NewTask",
          name: "New task",
          workType: "routine_work",
          reconfigure: ["workType"],
          permissions: "adminWorker",
          only: ["et_englandwales", "et_scotland"],
          create: [{ event: "newEvent", postState: "Submitted" }]
        }
      ]
    } as Model;
    const spec = compileModel(added, lifted.ordering);
    const before = lifted.spec.decisions;
    expect(spec.decisions.initiation?.rows).toHaveLength((before.initiation?.rows.length ?? 0) + 1);
    expect(spec.decisions.initiation?.rows.at(-1)?.returns?.taskId).toBe("NewTask");
    expect(spec.decisions.initiation?.rows.at(-1)?.only).toEqual(["et_englandwales", "et_scotland"]);
    expect(spec.decisions["task-types"]?.rows.at(-1)?.returns).toEqual({ taskTypeId: "NewTask", taskTypeName: "New task" });
    expect(spec.decisions.configuration?.rows).toHaveLength(before.configuration?.rows.length ?? 0);
    const workType = spec.decisions.configuration?.rows.filter((r) => r.returns?.name === "workType" && taskCell(r).includes("NewTask"));
    expect(workType).toHaveLength(1);
    expect(spec.decisions.permissions?.rows).toHaveLength(before.permissions?.rows.length ?? 0);
    const others = diffSpecs(
      { ...lifted.spec, decisions: { ...before, initiation: undefined, "task-types": undefined, configuration: undefined, permissions: undefined } },
      { ...spec, decisions: { ...spec.decisions, initiation: undefined, "task-types": undefined, configuration: undefined, permissions: undefined } }
    );
    expect(others).toEqual([]);
  });

  it("should change every task's row for the role and no other when a profile used by several tasks is edited", () => {
    const profile = lifted.model.permissionProfiles?.adminWorker;
    const inherits = (t: Model["tasks"][number]) =>
      t.permissions === "adminWorker" || (typeof t.permissions === "object" && !Array.isArray(t.permissions) && t.permissions.profile === "adminWorker");
    const users = lifted.model.tasks.filter(inherits).map((t) => t.id);
    expect(users.length).toBeGreaterThan(5);
    const edited = {
      ...lifted.model,
      permissionProfiles: {
        ...lifted.model.permissionProfiles,
        adminWorker: { ...profile, "hearing-centre-admin": { ...profile?.["hearing-centre-admin"], perms: ["Read"] } }
      }
    } as Model;
    const spec = compileModel(edited, lifted.ordering);
    const original = lifted.spec.decisions.permissions?.rows ?? [];
    const rows = spec.decisions.permissions?.rows ?? [];
    const changed = rows.filter((r) => r.returns?.value === "Read");
    expect(changed.flatMap(taskCell).sort(byCodePoint)).toEqual([...users].sort(byCodePoint));
    expect(rows.length).toBeGreaterThanOrEqual(original.length);
    expect(rows.filter((r) => r.returns?.name === "allocated-admin-caseworker").length).toBe(
      original.filter((r) => r.returns?.name === "allocated-admin-caseworker").length
    );
    expect(
      diffSpecs(
        { ...lifted.spec, decisions: { ...lifted.spec.decisions, permissions: undefined } },
        { ...spec, decisions: { ...spec.decisions, permissions: undefined } }
      )
    ).toEqual([]);
  });

  it("should scope the rows to the case type when a case type override is added to a value", () => {
    const edited = {
      ...lifted.model,
      tasks: lifted.model.tasks.map((t) => (t.id === "Et1Vetting" ? { ...t, due: { days: { value: 5, overrides: { et_scotland: 10 } } } } : t))
    } as Model;
    const rows =
      compileModel(edited, lifted.ordering).decisions.configuration?.rows.filter(
        (r) => r.returns?.name === "dueDateIntervalDays" && taskCell(r).includes("Et1Vetting")
      ) ?? [];
    const summary = rows.map((r) => ({ only: r.only, value: r.returns?.value, tasks: taskCell(r).length > 0 }));
    expect(summary).toContainEqual({ only: ["et_scotland"], value: 10, tasks: true });
    expect(summary).toContainEqual({ only: ["et_englandwales"], value: 5, tasks: true });
    expect(summary.find((s) => s.value === 5)?.only).not.toContain("et_scotland");
  });
});

describe("liftSpec on a varied model", () => {
  const model = parseModel(VARIED);
  const spec = compileModel(model);
  const _lifted = liftSpec(spec);

  it("should place new rows after the rows the ordering names when the ordering is stale", () => {
    const stale = { version: 1 as const, rows: { initiation: ["A/create", "Gone/create"] } };
    const rows = compileModel(model, stale).decisions.initiation?.rows ?? [];
    expect(rows.map((r) => r.returns?.taskId)).toEqual(["A", "B"]);
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
    const task = model.tasks.find((t) => t.id === "A") as Model["tasks"][number];
    const entries = task.attributes?.custom as unknown[];
    const edited = {
      ...model,
      tasks: model.tasks.map((t) => (t === task ? { ...task, attributes: { custom: [{ value: 0, only: ["ct_b"] }, ...entries] } } : t))
    } as Model;
    const before = configRows(model, lifted.ordering)
      .filter((r) => r.returns?.name === "custom")
      .map((r) => r.returns?.value);
    const after = configRows(edited, lifted.ordering)
      .filter((r) => r.returns?.name === "custom")
      .map((r) => r.returns?.value);
    expect(before).toEqual([1, 2]);
    expect(after).toEqual([1, 2, 0]);
  });
});

describe("round five", () => {
  it("should give a trigger the task type's name when it has no initial name, and keep an explicit null", () => {
    const model = parseModel(`
kind: wa-model
version: 1
service: {slug: demo}
caseTypes: [{id: ct_a}]
tasks:
  - id: T
    name: The task
    create: [{event: e1}, {event: e2, initialName: Other}, {event: e3, initialName: null}]
`);
    const rows = compileModel(model).decisions.initiation?.rows ?? [];
    expect(rows.map((r) => r.returns?.name)).toEqual(["The task", "Other", null]);
  });
});

describe("round six names and refs", () => {
  const NAMED = (name: string, extra = "") => `
kind: wa-model
version: 1
service: {slug: demo}
caseTypes: [{id: ct_a}, {id: ct_b}]
tasks:
  - id: T
    name: ${name}
    create: [{event: e${extra}}]
`;

  it("should take a name with a note for a trigger that has no initial name when compiling", () => {
    const rows = compileModel(parseModel(NAMED("{value: Noted, note: heads the row}"))).decisions.initiation?.rows ?? [];
    expect(rows.map((r) => r.returns?.name)).toEqual(["Noted"]);
  });

  it("should take each case type's own name for a trigger that has no initial name when the names are split by case type", () => {
    const rows = compileModel(parseModel(NAMED("[{value: Alpha, only: [ct_a]}, {value: Beta, only: [ct_b]}]"))).decisions.initiation?.rows ?? [];
    expect(rows.map((r) => [r.only, r.returns?.name])).toEqual([
      [["ct_a"], "Alpha"],
      [["ct_b"], "Beta"]
    ]);
  });

  it("should name nothing for a case type the task has no name for when compiling a trigger with no initial name", () => {
    const rows = compileModel(parseModel(NAMED("{value: Alpha, only: [ct_a]}"))).decisions.initiation?.rows ?? [];
    expect(rows.map((r) => [r.only ?? null, r.returns?.name])).toEqual([
      [["ct_a"], "Alpha"],
      [["ct_b"], undefined]
    ]);
  });

  it("should drop the entry for a case type when a value override is null, and keep a null value written as {value: null}", () => {
    const text = (override: string) => `
kind: wa-model
version: 1
service: {slug: demo}
caseTypes: [{id: ct_a}, {id: ct_b}]
tasks: [{id: T, title: {value: x, overrides: {ct_b: ${override}}}}]
`;
    const rows = (override: string) => configRows(parseModel(text(override))).map((r) => [r.only ?? null, r.returns?.value]);
    expect(rows("null")).toEqual([[["ct_a"], "x"]]);
    expect(rows("{value: null}")).toEqual([
      [["ct_a"], "x"],
      [["ct_b"], null]
    ]);
    expect(rows("y")).toEqual([
      [["ct_a"], "x"],
      [["ct_b"], "y"]
    ]);
  });
});

describe("round seven", () => {
  const lifted = liftSpec(compileModel(parseModel(BASE)));
  const model = parseModel(stringifyModel(lifted.model));

  it("should append a new cancellation rule and not give it a deleted rule's place when a rule is deleted and another added", () => {
    const kept = (model.cancellations ?? []).filter((r) => r.id !== "Cancel-gone");
    const edited = { ...model, cancellations: [...kept, { id: "NewRule", events: "new", action: "Cancel", categories: ["X"] }] } as Model;
    const rows = compileModel(edited, lifted.ordering).decisions.cancellation?.rows ?? [];
    expect(rows.map((r) => JSON.stringify(r.when?.event))).toEqual(['{"in":["moved"]}', '{"in":["new"]}']);
  });
});

describe("round eight", () => {
  const fixtures = fileURLToPath(new URL("../test-fixtures/et", import.meta.url));
  const files = readdirSync(fixtures)
    .filter((n) => n.startsWith("wa-task-") && n.endsWith(".dmn"))
    .map((name) => ({ name, xml: readFileSync(join(fixtures, name), "utf8") }));
  const { spec } = importDmns(files, { jurisdiction: "EMPLOYMENT" });
  const lifted = liftSpec(spec);
  const model = parseModel(stringifyModel(lifted.model));

  it("should keep the description of a row shared by several tasks when the first task is deleted", () => {
    const without = { ...model, tasks: model.tasks.filter((t) => t.id !== "Et1Vetting") } as Model;
    const rows = configRows(without, lifted.ordering).filter((r) => r.returns?.name === "workType" && r.returns?.value === "routine_work");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => typeof r.description === "string" && r.description.includes("type of work"))).toBe(true);
    expect(rows.some((r) => tasksOf(r).includes("Et1Vetting"))).toBe(false);
  });
});
