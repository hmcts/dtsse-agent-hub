import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Spec } from "../schema.ts";
import { parseSpec, specFromDocument } from "../spec-io.ts";
import { simulate } from "./simulate.ts";

const et = parseSpec(readFileSync(fileURLToPath(new URL("../../examples/et/spec.yaml", import.meta.url)), "utf8"));
const names = (items: Array<{ task: { taskType: string } }>) => items.map((item) => item.task.taskType);

describe("ET1 Vetting", () => {
  const caseData = { claimant: "Ada Lovelace", respondent: "Babbage Ltd", ethosCaseReference: "6000001/2025" };
  const input = { caseType: "et_englandwales", caseData, today: "2026-11-19" };

  it("should create the task with its configuration and permissions when SUBMIT_CASE_DRAFT moves the case to Submitted", () => {
    const { steps } = simulate(et, { ...input, events: [{ event: "SUBMIT_CASE_DRAFT", postState: "Submitted" }] });
    const created = steps[0]?.created ?? [];
    expect(created.map((t) => [t.taskType, t.name, t.processCategories])).toEqual([["Et1Vetting", "Et1 Vetting", ["Vetting"]]]);
    const task = created[0];
    expect(task?.initiation).toEqual({ taskId: "Et1Vetting", name: "Et1 Vetting", processCategories: "Vetting" });
    expect(task?.attributes).toMatchObject({
      caseName: "6000001/2025 - Ada Lovelace v Babbage Ltd",
      workType: "routine_work",
      roleCategory: "ADMIN",
      majorPriority: "5000",
      minorPriority: "500",
      dueDateIntervalDays: "5",
      dueDateMustBeWorkingDay: "Yes",
      dueDateTime: "16:00"
    });
    expect(task?.configuration.find((entry) => entry.name === "caseName")).toEqual({
      name: "caseName",
      value: "6000001/2025 - Ada Lovelace v Babbage Ltd",
      canReconfigure: true
    });
    expect(task?.permissions.find((p) => p.role === "allocated-admin-caseworker")).toEqual({
      role: "allocated-admin-caseworker",
      permissions: ["Read", "Own", "Manage", "Claim", "Unclaim", "UnclaimAssign", "CompleteOwn"],
      roleCategory: "ADMIN",
      assignmentPriority: 2,
      autoAssignable: true
    });
  });

  it("should give the due date origin the instant it is told is now when one is given", () => {
    const { tasks } = simulate(et, { ...input, now: "2026-11-20T00:00:00Z", events: [{ event: "SUBMIT_CASE_DRAFT", postState: "Submitted" }] });
    expect(tasks[0]?.attributes.dueDateOrigin).toBe("2026-11-20T00:00Z[UTC]");
  });

  it("should not create the task when the event is SUBMIT_CASE_DRAFT but the case is not Submitted", () => {
    const { steps } = simulate(et, { ...input, events: [{ event: "SUBMIT_CASE_DRAFT", postState: "Draft" }] });
    expect(steps[0]?.created).toEqual([]);
  });

  it("should complete the task automatically when preAcceptanceCase follows", () => {
    const { steps, tasks } = simulate(et, {
      ...input,
      events: [
        { event: "SUBMIT_CASE_DRAFT", postState: "Submitted" },
        { event: "preAcceptanceCase", postState: "Accepted" }
      ]
    });
    expect(steps[1]?.completed).toEqual([{ task: { id: "Et1Vetting-1", taskType: "Et1Vetting", name: "Et1 Vetting" }, completionMode: "Auto" }]);
    expect(tasks.find((t) => t.taskType === "Et1Vetting")?.state).toBe("completed");
    expect(steps[0]?.created[0]?.state).toBe("open");
  });

  it("should cancel the task by its process category when disposeCase follows", () => {
    const { steps, tasks } = simulate(et, { ...input, events: [{ event: "SUBMIT_CASE_DRAFT", postState: "Submitted" }, { event: "disposeCase" }] });
    expect(steps[1]?.cancelled).toEqual([{ task: { id: "Et1Vetting-1", taskType: "Et1Vetting", name: "Et1 Vetting" }, processCategories: ["Vetting"] }]);
    expect(tasks[0]?.state).toBe("cancelled");
    expect(steps[1]?.fromState).toBe("Submitted");
  });

  it("should leave the task open when an event neither completes nor cancels it", () => {
    const { tasks } = simulate(et, { ...input, events: [{ event: "SUBMIT_CASE_DRAFT", postState: "Submitted" }, { event: "unrelated" }] });
    expect(tasks.map((t) => t.state)).toEqual(["open"]);
  });

  it("should give no tasks when the case type has no DMNs of a kind", () => {
    const { tasks } = simulate(
      { ...et, caseTypes: [...et.caseTypes, { id: "other" }] },
      { caseType: "other", events: [{ event: "SUBMIT_CASE_DRAFT", postState: "Submitted" }] }
    );
    expect(tasks).toEqual([]);
  });
});

const column = (key: string) => ({ key, variable: key });
const spec = (): Spec =>
  specFromDocument({
    version: 1,
    service: { slug: "demo", jurisdiction: "DEMO" },
    caseTypes: [{ id: "demo_case" }],
    decisions: {
      initiation: {
        name: "init",
        hitPolicy: "COLLECT",
        inputs: [column("eventId"), column("postEventState"), { key: "due", variable: "due", expression: { field: "directionDueDate" } }],
        outputs: [{ name: "taskId" }, { name: "name" }, { name: "processCategories" }],
        rows: [
          { when: { eventId: { in: ["open"] } }, returns: { taskId: "TaskA", name: "Task A", processCategories: "Cat1, Cat2" } },
          { when: { eventId: { in: ["open"] } }, returns: { taskId: "TaskB", name: "Task B", processCategories: "Cat2" } },
          { when: { eventId: { in: ["due"] }, due: { in: ["2026-12-01"] } }, returns: { taskId: "TaskC", name: "Task C" } }
        ]
      },
      configuration: {
        name: "config",
        hitPolicy: "COLLECT",
        inputs: [{ key: "taskType", variable: "taskType", expression: { feel: "taskAttributes.taskType" } }],
        outputs: [{ name: "name" }, { name: "value" }, { name: "canReconfigure", typeRef: "boolean" }],
        rows: [
          {
            when: { taskType: { in: ["TaskA"] } },
            returns: { name: "region", value: { feel: 'if caseData.region != null then caseData.region else "1"' }, canReconfigure: true }
          },
          {
            when: { taskType: { in: ["TaskA"] } },
            returns: { name: "tags", value: { feel: 'if caseData.tags != null then caseData.tags else "a, b, c"' }, canReconfigure: false }
          }
        ]
      },
      permissions: {
        name: "perms",
        hitPolicy: "RULE ORDER",
        inputs: [{ key: "taskType", variable: "taskType", expression: { feel: "taskAttributes.taskType" } }],
        outputs: [
          { name: "name" },
          { name: "value" },
          { name: "caseAccessCategory" },
          { name: "roleCategory" },
          { name: "authorisations" },
          { name: "assignmentPriority", typeRef: "integer" },
          { name: "autoAssignable", typeRef: "boolean" }
        ],
        rows: [
          { returns: { name: "supervisor", value: "Read, Manage", autoAssignable: false } },
          {
            returns: {
              name: "civil-only",
              value: "Read",
              caseAccessCategory: "CIVIL, FAMILY",
              roleCategory: "LEGAL_OPERATIONS",
              authorisations: "A, B",
              assignmentPriority: 3,
              autoAssignable: true
            }
          }
        ]
      },
      completion: {
        name: "completion",
        hitPolicy: "COLLECT",
        inputs: [column("eventId")],
        outputs: [{ name: "taskType" }, { name: "completionMode" }],
        rows: [
          { when: { eventId: { in: ["finish"] } }, returns: { taskType: "TaskA", completionMode: "Auto" } },
          { when: { eventId: { in: ["finish"] } }, returns: { taskType: "TaskB", completionMode: "UserComplete" } },
          { when: { eventId: { in: ["finish"] } }, returns: {} }
        ]
      },
      cancellation: {
        name: "cancellation",
        hitPolicy: "COLLECT",
        inputs: [{ key: "event", variable: "event" }, column("state"), column("fromState")],
        outputs: [{ name: "action" }, { name: "warningCode" }, { name: "warningText" }, { name: "processCategories" }],
        rows: [
          { when: { event: { in: ["cancelCat1"] } }, returns: { action: "Cancel", processCategories: "Cat1" } },
          { when: { event: { in: ["cancelBoth"] } }, returns: { action: "Cancel", processCategories: "Cat1, Cat2" } },
          { when: { event: { in: ["cancelAll"] } }, returns: { action: "Cancel" } },
          { when: { event: { in: ["warn"] } }, returns: { action: "Warn", warningCode: "W1", warningText: "Careful", processCategories: "Cat2" } },
          { when: { event: { in: ["warn"] } }, returns: { action: "Warn", processCategories: "Cat2" } },
          { when: { event: { in: ["reconfigure"] } }, returns: { action: "Reconfigure" } }
        ]
      }
    }
  });

describe("task lifecycle", () => {
  const run = (events: Parameters<typeof simulate>[1]["events"], caseData: Record<string, unknown> = {}) =>
    simulate(spec(), { caseType: "demo_case", caseData, today: "2026-11-19", events: [{ event: "open", postState: "Open" }, ...events] });

  it("should split process categories on commas when a task is created", () => {
    const { steps } = run([]);
    expect(steps[0]?.created.map((t) => [t.id, t.processCategories])).toEqual([
      ["TaskA-1", ["Cat1", "Cat2"]],
      ["TaskB-2", ["Cat2"]]
    ]);
  });

  it("should trim the spaces after commas in what a DMN returns when it is configuration or permissions", () => {
    const [a] = run([]).steps[0]?.created ?? [];
    expect(a?.attributes).toEqual({ region: "1", tags: "a,b,c" });
    expect(a?.permissions[0]).toMatchObject({ role: "supervisor", permissions: ["Read", "Manage"], autoAssignable: false });
  });

  it("should give a rule with a case access category only to a case that has one of them", () => {
    const roles = (caseData: Record<string, unknown>) => run([], caseData).steps[0]?.created[0]?.permissions.map((p) => p.role);
    expect(roles({})).toEqual(["supervisor"]);
    expect(roles({ caseAccessCategory: "FAMILY" })).toEqual(["supervisor", "civil-only"]);
    expect(roles({ caseAccessCategory: "CRIME" })).toEqual(["supervisor"]);
  });

  it("should return the permission fields when a rule sets them all", () => {
    const [, civil] = run([], { caseAccessCategory: "CIVIL" }).steps[0]?.created[0]?.permissions ?? [];
    expect(civil).toEqual({
      role: "civil-only",
      permissions: ["Read"],
      roleCategory: "LEGAL_OPERATIONS",
      authorisations: ["A", "B"],
      assignmentPriority: 3,
      autoAssignable: true,
      caseAccessCategory: "CIVIL, FAMILY"
    });
  });

  it("should read case data in configuration when the event adds it", () => {
    const { tasks } = simulate(spec(), { caseType: "demo_case", events: [{ event: "open", caseData: { region: "7" } }] });
    expect(tasks[0]?.attributes.region).toBe("7");
  });

  it("should complete the Auto task and offer the other when completion names both", () => {
    const { steps } = run([{ event: "finish" }]);
    expect(names(steps[1]?.completed ?? [])).toEqual(["TaskA"]);
    expect(steps[1]?.completable).toEqual([{ task: { id: "TaskB-2", taskType: "TaskB", name: "Task B" }, completionMode: "UserComplete" }]);
  });

  it("should cancel only tasks that have every listed category", () => {
    expect(names(run([{ event: "cancelCat1" }]).steps[1]?.cancelled ?? [])).toEqual(["TaskA"]);
    expect(names(run([{ event: "cancelBoth" }]).steps[1]?.cancelled ?? [])).toEqual(["TaskA"]);
  });

  it("should cancel every open task when the row names no category", () => {
    expect(names(run([{ event: "cancelAll" }]).steps[1]?.cancelled ?? [])).toEqual(["TaskA", "TaskB"]);
  });

  it("should warn the tasks in the category when the row has a code and text and ignore a row without them", () => {
    const { steps, tasks } = run([{ event: "warn" }]);
    expect(steps[1]?.warned.map((w) => [w.task.taskType, w.code, w.text])).toEqual([
      ["TaskA", "W1", "Careful"],
      ["TaskB", "W1", "Careful"]
    ]);
    expect(tasks[0]?.warnings).toEqual([{ code: "W1", text: "Careful" }]);
  });

  it("should report the reconfigurable attributes that change when case data changes", () => {
    const { steps, tasks } = run([{ event: "reconfigure", caseData: { region: "9" } }]);
    expect(steps[1]?.reconfigured).toEqual([
      { task: { id: "TaskA-1", taskType: "TaskA", name: "Task A" }, changes: [{ name: "region", from: "1", to: "9" }] },
      { task: { id: "TaskB-2", taskType: "TaskB", name: "Task B" }, changes: [] }
    ]);
    expect(tasks[0]?.attributes.region).toBe("9");
  });

  it("should leave an attribute alone when the configuration DMN says it cannot be reconfigured", () => {
    const { steps, tasks } = run([{ event: "reconfigure", caseData: { tags: "changed" } }]);
    expect(steps[1]?.reconfigured[0]?.changes).toEqual([]);
    expect(tasks[0]?.attributes.tags).toBe("a,b,c");
    expect(tasks[0]?.configuration.find((c) => c.name === "tags")?.value).toBe("a,b,c");
  });

  it("should match the case access category as task management does when the case lists it without trimming", () => {
    const roles = (caseAccessCategory: unknown) => run([], { caseAccessCategory }).steps[0]?.created[0]?.permissions.map((p) => p.role);
    expect(roles("CRIME,CIVIL")).toEqual(["supervisor", "civil-only"]);
    expect(roles("CRIME, CIVIL")).toEqual(["supervisor"]);
    expect(roles("  ")).toEqual(["supervisor"]);
    expect(roles(7)).toEqual(["supervisor"]);
  });

  it("should keep the state when an event gives no post state", () => {
    const { steps } = run([{ event: "cancelCat1" }]);
    expect(steps[1]?.postState).toBe("Open");
  });

  it("should not change a step's snapshot of a task when a later step warns it", () => {
    const { steps, tasks } = run([{ event: "warn" }]);
    expect(steps[0]?.created[0]?.warnings).toEqual([]);
    expect(tasks[0]?.warnings).toHaveLength(1);
  });

  it("should not reconfigure or cancel a task that is already complete", () => {
    const { steps } = run([{ event: "finish" }, { event: "cancelCat1" }]);
    expect(steps[2]?.cancelled).toEqual([]);
  });

  it("should give initiation the direction due date from the case data when it has one", () => {
    const { steps } = simulate(spec(), { caseType: "demo_case", caseData: { lastModifiedDirection: { dateDue: "2026-12-01" } }, events: [{ event: "due" }] });
    expect(steps[0]?.created.map((t) => t.taskType)).toEqual(["TaskC"]);
    expect(steps[0]?.created[0]?.processCategories).toEqual([]);
  });

  it("should run with no date given when initiation reads none", () => {
    expect(simulate(spec(), { caseType: "demo_case", events: [{ event: "open" }] }).steps).toHaveLength(1);
  });

  it("should take the state before an event from the one before it unless the event says", () => {
    const { steps } = run([{ event: "x", postState: "Closed" }, { event: "y" }, { event: "z", fromState: "Elsewhere" }]);
    expect(steps.map((s) => s.fromState)).toEqual([undefined, "Open", "Closed", "Elsewhere"]);
  });
});
