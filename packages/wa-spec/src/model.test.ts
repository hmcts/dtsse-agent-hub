import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { importDmns } from "./importer.ts";
import { byCodePoint } from "./merge.ts";
import { decodeCell, encodeCell, linkText, type Model, type Ordering, parseLinkText, validateModel } from "./model.ts";
import { compileModel } from "./model-compile.ts";
import { isModelDocument, loadSpecFile, orderPathFor, parseModel, parseOrdering, stringifyModel, stringifyOrdering } from "./model-io.ts";
import { liftSpec, renderLiftReport } from "./model-lift.ts";
import type { Kind, Row } from "./schema.ts";
import { diffSpecs } from "./spec-diff.ts";
import { stringifySpec } from "./spec-io.ts";

const SMALL = `
kind: wa-model
version: 1
service: {slug: demo, jurisdiction: DEMO}
caseTypes: [{id: ct_a}, {id: ct_b}]
roles:
  admin: {category: ADMIN}
  leader: {}
permissionProfiles:
  adminWorker:
    admin: {perms: [Read, Own], priority: 2, autoAssign: true}
    leader: {perms: [Assign], autoAssign: false, category: ADMIN}
tasks:
  - id: Vetting
    name: Vetting
    workType: routine_work
    permissions: adminWorker
    create:
      - {event: submit, postState: Submitted}
    complete: [{event: vetted, mode: Auto}]
    cancelCategory: Vetting
    due: {days: 5}
    link: {label: Vet, event: vet, page: vet1}
    reconfigure: [workType]
  - id: Review
    name: Review
    workType: routine_work
    permissions: adminWorker
    create:
      - {event: [review, rereview]}
    reconfigure: [workType]
cancellations:
  - {events: [dispose, close], action: Cancel, categories: [Vetting, Review]}
  - {events: moved, action: Reconfigure}
`;

const small = (): Model => parseModel(SMALL);
const rowsOf = (model: Model, kind: Kind, ordering?: Ordering): Row[] => compileModel(model, ordering).decisions[kind]?.rows ?? [];
const taskCell = (row: Row): string[] => (row.when?.taskType as { in: string[] } | undefined)?.in ?? [];

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

describe("cell codec", () => {
  it("should read a bare value or a list as an in-list and write one value back bare when it round-trips", () => {
    expect(decodeCell("a")).toEqual({ in: ["a"] });
    expect(decodeCell(["a", "b"])).toEqual({ in: ["a", "b"] });
    expect(encodeCell({ in: ["a"] })).toBe("a");
    expect(encodeCell({ in: ["a", "b"] })).toEqual(["a", "b"]);
    expect(encodeCell({ notIn: ["a"] })).toEqual({ notIn: ["a"] });
  });
});

const fixtures = fileURLToPath(new URL("../test-fixtures/et", import.meta.url));
const et = () => {
  const files = readdirSync(fixtures)
    .filter((n) => n.startsWith("wa-task-") && n.endsWith(".dmn"))
    .map((name) => ({ name, xml: readFileSync(join(fixtures, name), "utf8") }));
  const { spec } = importDmns(files, { jurisdiction: "EMPLOYMENT" });
  const { model, ordering, report } = liftSpec(spec);
  return { spec, model: parseModel(stringifyModel(model)), ordering: parseOrdering(stringifyOrdering(ordering)), report };
};

describe("liftSpec and compileModel on ET", () => {
  const lifted = et();

  it("should compile back to the original spec when the model and its ordering are written and read again", () => {
    expect(lifted.report.differences).toEqual([]);
    expect(diffSpecs(lifted.spec, compileModel(lifted.model, lifted.ordering))).toEqual([]);
  });

  it("should lift every row about a task and keep the two rows that complete no task when lifting", () => {
    expect(lifted.report.counts.initiation.residue).toBe(0);
    expect(lifted.report.counts.configuration.residue).toBe(0);
    expect(lifted.report.counts.permissions.residue).toBe(0);
    expect(lifted.report.counts.completion.residue).toBe(2);
    expect(lifted.model.tables?.completion?.rows).toHaveLength(2);
    expect(renderLiftReport(lifted.report, "ET")).toContain("completion row 30");
  });

  it("should group tasks with identical grants into permission profiles when lifting", () => {
    const profiles = lifted.model.permissionProfiles ?? {};
    expect(Object.keys(profiles).length).toBeGreaterThanOrEqual(3);
    const used = lifted.model.tasks.filter((t) => typeof t.permissions === "string");
    expect(used.length).toBeGreaterThan(20);
    expect(Object.keys(profiles.adminWorker ?? {})).toEqual(["allocated-admin-caseworker", "hearing-centre-team-leader", "hearing-centre-admin"]);
  });

  it("should read like the plan's sketch when lifting ET1 Vetting", () => {
    const task = lifted.model.tasks.find((t) => t.id === "Et1Vetting");
    expect(task).toMatchObject({
      name: "ET1 Vetting",
      workType: "routine_work",
      roleCategory: "ADMIN",
      cancelCategory: "Vetting",
      due: { days: 5 },
      priority: { major: 5000, minor: 500, dateOriginRef: "dueDate" },
      link: { label: "ET1 Vetting", event: "et1Vetting", page: "et1Vetting1" }
    });
    expect(task?.create?.map((t) => t.event)).toEqual(["SUBMIT_CASE_DRAFT", "initiateCase", "submitEt1Draft", "createEcmCase"]);
    expect(task?.complete).toEqual([{ event: "preAcceptanceCase", mode: "Auto" }]);
  });

  it("should collapse a rule's categories into one cancellation when adjacent rows differ only in category", () => {
    const first = lifted.model.cancellations?.[0];
    expect(first?.events).toEqual(["disposeCase", "rollbackMigrateCase", "caseTransferECM"]);
    expect(first?.categories).toHaveLength(7);
  });

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

const VARIED = `
kind: wa-model
version: 1
service: {slug: demo}
caseTypes: [{id: ct_a}, {id: ct_b}]
roles:
  admin: {category: ADMIN}
  leader: {category: ADMIN}
  judge: {category: JUDICIAL}
permissionProfiles:
  adminWorker:
    admin: {perms: [Read, Own], priority: 2, autoAssign: true}
    leader: {perms: [Assign], autoAssign: false}
tasks:
  - {id: A, name: A, permissions: adminWorker, create: [{event: a, postState: Open}], cancelCategory: Cat}
  - {id: B, name: B, permissions: adminWorker, create: [{event: b, delay: 2}], cancelCategory: Cat}
  - {id: C, name: C, permissions: {profile: adminWorker, override: {admin: {priority: 9}}}}
  - {id: D, name: D, permissions: {profile: adminWorker, remove: [leader]}}
  - id: E
    name: [{value: E, only: [ct_a]}, {value: E two, only: [ct_b]}]
    permissions:
      - {only: [ct_a], profile: adminWorker}
      - {only: [ct_b], add: {judge: {perms: [Read, Own], autoAssign: true}}}
    additionalProperties: {roleAssignmentId: {value: x, reconfigure: true}}
    attributes: {custom: [{value: 1, only: [ct_a]}, {value: 2, only: [ct_b]}]}
    title: Task E
    description: plain text
cancellations:
  - {events: gone, fromState: Open, state: Closed, action: Warn, warning: {code: W1, text: Careful}, note: warns, only: [ct_a]}
`;

describe("liftSpec on a varied model", () => {
  const model = parseModel(VARIED);
  const spec = compileModel(model);
  const lifted = liftSpec(spec);

  it("should compile back to the spec when the model has deltas, case type variants and a warning", () => {
    expect(lifted.report.differences).toEqual([]);
  });

  it("should express a task as a profile with changes when its grants are close to a shared profile, and inline when they are not", () => {
    const tasks = Object.fromEntries(lifted.model.tasks.map((t) => [t.id, t]));
    const profile = tasks.A?.permissions as string;
    expect(profile).toMatch(/Worker$/);
    expect(tasks.B?.permissions).toBe(profile);
    expect(tasks.C?.permissions).toEqual({ profile, override: { admin: { priority: 9 } } });
    expect(tasks.D?.permissions).toEqual({ add: { admin: { perms: ["Read", "Own"], priority: 2, autoAssign: true } } });
  });

  it("should keep case type variants and a repeated slot's entries when lifting a task that differs by case type", () => {
    const e = lifted.model.tasks.find((t) => t.id === "E");
    expect(e?.name).toEqual([
      { value: "E", only: ["ct_a"] },
      { value: "E two", only: ["ct_b"] }
    ]);
    expect(e?.attributes).toEqual({
      custom: [
        { value: 1, only: ["ct_a"] },
        { value: 2, only: ["ct_b"] }
      ]
    });
    expect(e?.additionalProperties).toEqual({ roleAssignmentId: "x" });
    expect(e?.reconfigure).toEqual(["additionalProperties_roleAssignmentId"]);
    expect(e?.description).toBe("plain text");
    expect(Array.isArray(e?.permissions)).toBe(true);
  });

  it("should lift a warning rule with its states and note when the rule has no category", () => {
    expect(lifted.model.cancellations).toEqual([
      {
        id: "Warn-gone",
        events: "gone",
        fromState: "Open",
        state: "Closed",
        action: "Warn",
        warning: { code: "W1", text: "Careful" },
        note: "warns",
        only: ["ct_a"]
      }
    ]);
  });

  it("should keep a row in tables with its reason when the task id is not a plain name", () => {
    const odd = structuredClone(spec);
    odd.decisions.initiation?.rows.push({ when: { eventId: { in: ["x"] } }, returns: { taskId: "not a name" } });
    const result = liftSpec(odd);
    expect(result.report.residue).toEqual([{ kind: "initiation", row: 3, reason: "it does not create a task with a plain task id" }]);
    expect(result.report.differences).toEqual([]);
    expect(result.model.tables?.initiation?.rows).toHaveLength(1);
  });

  it("should leave only the rows granting a role twice as rows when a role is granted twice to one task for a case type", () => {
    const twice = structuredClone(spec);
    const first = twice.decisions.permissions?.rows[0] as Row;
    twice.decisions.permissions?.rows.push(structuredClone(first));
    const result = liftSpec(twice);
    const total = spec.decisions.permissions?.rows.length ?? 0;
    expect(result.report.counts.permissions).toEqual({ rows: total + 1, lifted: total - 1, residue: 2 });
    expect(result.report.residue.some((r) => r.kind === "permissions" && r.reason.includes("twice"))).toBe(true);
    expect(result.report.differences).toEqual([]);
  });

  it("should place new rows after the rows the ordering names when the ordering is stale", () => {
    const stale = { version: 1 as const, rows: { initiation: ["A/create", "Gone/create"] } };
    const rows = compileModel(model, stale).decisions.initiation?.rows ?? [];
    expect(rows.map((r) => r.returns?.taskId)).toEqual(["A", "B"]);
  });
});

describe("loadSpecFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-spec-io-"));

  it("should compile a model with its ordering file and read a spec as it is when loading either", () => {
    const model = parseModel(VARIED);
    const lifted = liftSpec(compileModel(model), { order: "m.order.yaml" });
    writeFileSync(join(dir, "m.yaml"), stringifyModel(lifted.model));
    writeFileSync(join(dir, "m.order.yaml"), stringifyOrdering(lifted.ordering));
    const loaded = loadSpecFile(join(dir, "m.yaml"));
    expect(loaded.isModel).toBe(true);
    expect(loaded.layout).toBeUndefined();
    expect(diffSpecs(loaded.spec, compileModel(model))).toEqual([]);
    expect(orderPathFor(join(dir, "m.yaml"), lifted.model)).toBe(join(dir, "m.order.yaml"));

    writeFileSync(join(dir, "s.yaml"), stringifySpec(loaded.spec));
    const plain = loadSpecFile(join(dir, "s.yaml"));
    expect(plain.isModel).toBe(false);
    expect(isModelDocument({ kind: "wa-model" })).toBe(true);
  });
});

describe("diffSpecs", () => {
  it("should name the path of a difference when specs differ in a value, a length or a key", () => {
    const a = compileModel(parseModel(SMALL));
    const b = structuredClone(a);
    (b.decisions.completion?.rows[0] as Row).returns = { taskType: "Other" };
    b.decisions.initiation?.rows.pop();
    b.service.displayName = "Demo";
    const differences = diffSpecs(a, b);
    expect(differences).toContain("spec.service.displayName: only in the second");
    expect(differences).toContain("spec.decisions.initiation.rows: 2 items vs 1");
    expect(differences.some((d) => d.startsWith("spec.decisions.completion.rows[0].returns"))).toBe(true);
  });
});
