import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BASE, base, cfgRow, et, NULL_NAME_SPEC, VARIANT_SPEC, VARIED } from "./__fixtures__/model.ts";
import { importDmns } from "./importer.ts";
import type { Model } from "./model.ts";
import { compileModel } from "./model-compile.ts";
import { parseModel, stringifyModel, stringifyOrdering } from "./model-io.ts";
import { liftSpec, renderLiftReport } from "./model-lift.ts";
import type { Kind, Row } from "./schema.ts";
import { diffSpecs } from "./spec-diff.ts";

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
});

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
});

describe("ordering references", () => {
  const lifted = liftSpec(compileModel(parseModel(BASE)));
  const _model = parseModel(stringifyModel(lifted.model));

  it("should name each cancellation rule by an id the lift writes when lifting", () => {
    expect((lifted.model.cancellations ?? []).map((r) => r.id)).toEqual(["Cancel-gone", "Reconfigure-moved"]);
    expect(stringifyOrdering(lifted.ordering)).toContain("!/Cancel-gone#");
  });
});

describe("round three", () => {
  it("should keep an explicit null category when the role has a category and when lifting it back", () => {
    const model = parseModel(`
kind: wa-model
version: 1
service: {slug: demo}
caseTypes: [{id: ct_a}]
roles: {admin: {category: ADMIN}}
permissionProfiles: {p: {admin: {perms: [Read], category: null}}}
tasks: [{id: A, permissions: p}]
`);
    const spec = compileModel(model);
    expect(spec.decisions.permissions?.rows[0]?.returns).toEqual({ name: "admin", value: "Read", roleCategory: null });
    expect(liftSpec(spec).report.differences).toEqual([]);
  });

  it("should lift event rows when the table spells its event column either way", () => {
    const spec = compileModel(parseModel(BASE));
    const initiation = spec.decisions.initiation;
    const completion = spec.decisions.completion;
    if (!initiation || !completion) {
      throw new Error("expected both tables");
    }
    const respell = (table: typeof initiation, from: string, to: string) => {
      for (const column of table.inputs) {
        column.key = column.key === from ? to : column.key;
      }
      for (const row of table.rows) {
        if (row.when && from in row.when) {
          row.when = Object.fromEntries(Object.entries(row.when).map(([k, v]) => [k === from ? to : k, v]));
        }
      }
    };
    respell(initiation, "eventId", "eventID");
    respell(completion, "eventID", "eventId");
    const lifted = liftSpec(spec);
    expect(lifted.report.counts.initiation.residue).toBe(0);
    expect(lifted.report.counts.completion.residue).toBe(0);
    expect(lifted.report.differences).toEqual([]);
  });
});

describe("round four", () => {
  it("should keep an explicit null name and category on one trigger when the other triggers share a value", () => {
    const lifted = liftSpec(NULL_NAME_SPEC);
    expect(lifted.report.differences).toEqual([]);
    expect(lifted.model.tasks[0]?.create?.[2]).toMatchObject({ initialName: null, cancelCategory: null });
    expect(compileModel(lifted.model, lifted.ordering).decisions.initiation?.rows[2]?.returns).toEqual({ taskId: "T", name: null, processCategories: null });
  });
});

describe("round five", () => {
  it("should leave initialName out when the task's creation name equals its name, and keep a different one", () => {
    const { model } = liftSpec(
      compileModel(
        parseModel(`
kind: wa-model
version: 1
service: {slug: demo}
caseTypes: [{id: ct_a}]
tasks:
  - {id: Same, name: Same, initialName: Same, create: [{event: e}]}
  - {id: Other, name: Other, initialName: Created, create: [{event: f}]}
`)
      )
    );
    expect(model.tasks.map((t) => t.initialName)).toEqual([undefined, "Created"]);
  });

  it("should keep a trigger with no name as a row when the task type has a name", () => {
    const spec = structuredClone(NULL_NAME_SPEC);
    const decisions = spec.decisions as Record<string, unknown>;
    decisions["task-types"] = {
      name: "t",
      hitPolicy: "COLLECT",
      inputs: [{ key: "input", typeRef: "string" }],
      outputs: [
        { name: "taskTypeId", typeRef: "string" },
        { name: "taskTypeName", typeRef: "string" }
      ],
      rows: [{ returns: { taskTypeId: "T", taskTypeName: "Task" } }]
    };
    spec.decisions.initiation.rows[0] = { when: { eventId: { in: ["e1"] } }, returns: { taskId: "T" } } as never;
    const lifted = liftSpec(spec as never);
    expect(lifted.report.residue).toEqual([{ kind: "initiation", row: 1, reason: "it creates a task with no name, but the task type has one" }]);
    expect(lifted.report.differences).toEqual([]);
  });

  it("should keep a row's description in the model, on the entry heading the row, when lifting, and not in the ordering", () => {
    const { model, ordering, report } = liftSpec(VARIANT_SPEC);
    expect(report.differences).toEqual([]);
    const z = model.tasks.find((t) => t.id === "Z") as Model["tasks"][number];
    expect(z.title).toEqual({ value: "z", note: "the last one" });
    expect(ordering.rows.configuration?.every((row) => typeof row === "string")).toBe(true);
  });

  it("should state a description in the ordering when the entry heading the row is also first in a row without one", () => {
    const spec = structuredClone(VARIANT_SPEC);
    spec.decisions.configuration.rows = [
      cfgRow({ taskType: { in: ["A"] } }, { name: "title", value: "x", canReconfigure: false }, ["ct_a"], "first"),
      cfgRow({ taskType: { in: ["A"] } }, { name: "title", value: "x", canReconfigure: false }, ["ct_b"])
    ] as never;
    const { ordering, report } = liftSpec(spec);
    expect(report.differences).toEqual([]);
    expect(ordering.rows.configuration?.some((row) => typeof row === "object" && row.description === null)).toBe(true);
  });
});

describe("round six", () => {
  it("should keep an expression language on a cell and on a value when lifting and compiling", () => {
    const spec = structuredClone(VARIANT_SPEC);
    spec.decisions.configuration.rows = [
      cfgRow({ taskType: { in: ["A"] } }, { name: "title", value: { feel: "caseData.a", language: "juel" }, canReconfigure: false }, undefined)
    ] as never;
    const initiation = {
      name: "i",
      hitPolicy: "COLLECT" as const,
      inputs: [
        { key: "eventId", typeRef: "string" },
        { key: "flag", typeRef: "string" }
      ],
      outputs: [{ name: "taskId", typeRef: "string" }],
      rows: [cfgRow({ eventId: { in: ["e"] }, flag: { feel: "x > 1", language: "juel" } }, { taskId: "A" })]
    };
    (spec.decisions as Record<string, unknown>).initiation = initiation;
    const lifted = liftSpec(spec as never);
    expect(lifted.report.differences).toEqual([]);
    expect(lifted.report.counts.initiation.residue).toBe(0);
    expect(lifted.model.tasks[0]?.create?.[0]?.when).toEqual({ flag: { feel: "x > 1", language: "juel" } });
    expect(lifted.model.tasks[0]?.title).toEqual({ feel: "caseData.a", language: "juel" });
  });

  it("should keep the allowed-days rows in tables when lifting a spec that has that kind", () => {
    const spec = structuredClone(VARIANT_SPEC);
    (spec.decisions as Record<string, unknown>)["allowed-days"] = {
      name: "d",
      hitPolicy: "COLLECT",
      inputs: [{ key: "taskId", typeRef: "string" }],
      outputs: [{ name: "workingDaysAllowed", typeRef: "integer" }],
      rows: [{ when: { taskId: { in: ["A"] } }, returns: { workingDaysAllowed: 3 } }]
    };
    const lifted = liftSpec(spec as never);
    expect(lifted.report.counts["allowed-days"]).toEqual({ rows: 1, lifted: 0, residue: 1 });
    expect(lifted.model.tables?.["allowed-days"]?.rows).toHaveLength(1);
    expect(lifted.report.differences).toEqual([]);
  });
});

describe("helper decision tables", () => {
  it("should carry a helper that is a decision table through the tables residue when lifting and compiling", () => {
    const spec = structuredClone(VARIANT_SPEC);
    (spec.decisions.configuration as Record<string, unknown>).helpers = [
      {
        name: "LOOKUP",
        hitPolicy: "FIRST",
        inputs: [{ key: "x", typeRef: "string" }],
        outputs: [{ name: "y", typeRef: "string" }],
        rows: [{ when: { x: { in: ["a"] } }, returns: { y: "b" } }]
      }
    ];
    const lifted = liftSpec(spec as never);
    expect(lifted.report.differences).toEqual([]);
    const helper = (lifted.model.tables?.configuration?.helpers ?? [])[0];
    expect(helper).toMatchObject({ name: "LOOKUP", hitPolicy: "FIRST" });
    expect(parseModel(stringifyModel(lifted.model)).tables?.configuration?.helpers?.[0]?.rows).toHaveLength(1);
  });
});

describe("round seven", () => {
  const lifted = liftSpec(compileModel(parseModel(BASE)));
  const _model = parseModel(stringifyModel(lifted.model));

  it("should name a profile neutrally when its roles' categories are not plain strings when lifting", () => {
    const text = `
kind: wa-model
version: 1
service: {slug: demo}
caseTypes: [{id: ct_a}]
roles: {a: {}}
permissionProfiles: {p: {a: {perms: [Read], category: {feel: c}, autoAssign: true}}}
tasks: [{id: A, permissions: p}, {id: B, permissions: p}]
`;
    const result = liftSpec(compileModel(parseModel(text)));
    expect(Object.keys(result.model.permissionProfiles ?? {})).toEqual(["profile1"]);
  });
});

describe("round seven residue categories", () => {
  it("should not check cancellation categories against tasks when initiation rows stay in tables", () => {
    const spec = compileModel(parseModel(BASE));
    const initiation = spec.decisions.initiation;
    if (!initiation) {
      throw new Error("expected initiation");
    }
    initiation.rows.push({ when: { eventId: { in: ["x"] } }, returns: { taskId: "not a name", processCategories: "Z" } });
    const cancellation = spec.decisions.cancellation?.rows[0];
    if (cancellation?.returns) {
      cancellation.returns.processCategories = "Z";
    }
    const lifted = liftSpec(spec);
    expect(lifted.report.counts.initiation.residue).toBe(1);
    expect(lifted.report.differences).toEqual([]);
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

  it("should keep a task's workType bare when the description of its shared row is in the ordering", () => {
    expect(model.tasks.find((t) => t.id === "Et1Vetting")?.workType).toBe("routine_work");
  });
});

describe("round nine", () => {
  it("should keep a cancellation row in tables when no task is created with its category", () => {
    const spec = compileModel(parseModel(BASE));
    const row = spec.decisions.cancellation?.rows[0];
    if (row?.returns) {
      row.returns.processCategories = "Deleted";
    }
    const lifted = liftSpec(spec);
    expect(lifted.report.differences).toEqual([]);
    expect(lifted.report.residue).toContainEqual({ kind: "cancellation", row: 1, reason: "no task is created with the category Deleted" });
    expect(lifted.model.tables?.cancellation?.rows).toHaveLength(1);
    expect(() => parseModel(stringifyModel(lifted.model))).not.toThrow();
  });

  it("should count every difference when lift reports more than the shown limit", () => {
    const lifted = liftSpec(compileModel(parseModel(BASE)));
    expect(lifted.report.totalDifferences).toBe(0);
  });
});

describe("lifting rows that are not about one task", () => {
  const reasons: Array<[Kind, Row, string]> = [
    ["initiation", { when: {}, returns: { taskId: "T" } }, "it has no event"],
    [
      "configuration",
      { when: { taskType: { in: ["not a name"] } }, returns: { name: "a", value: "b", canReconfigure: false } },
      "its taskType is not a plain list of task ids"
    ],
    ["configuration", { returns: { name: "not a name", value: "b", canReconfigure: false } }, "it is not an attribute name, a value and a reconfigure flag"],
    ["permissions", { when: { taskType: { in: ["not a name"] } }, returns: { name: "admin", value: "Read" } }, "its taskType is not a plain list of task ids"],
    ["permissions", { when: { case: { in: ["x"] } }, returns: { name: "admin", value: "Read" } }, "it has conditions beyond the task type"],
    ["permissions", { returns: { name: "admin", value: 3 } }, "its permissions are not a plain list"],
    ["completion", { when: {}, returns: { taskType: "Vetting" } }, "it has no event, or conditions beyond it"],
    ["task-types", { returns: { taskTypeId: "T" } }, "it is not a task type and its name"],
    ["cancellation", { when: {}, returns: { action: "Cancel" } }, "it is not an event, an action and optionally a category"],
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

describe("lifting default grants", () => {
  const withRows = (...rows: Row[]) => {
    const spec = base();
    const permissions = spec.decisions.permissions;
    if (permissions === undefined) {
      throw new Error("no permissions");
    }
    permissions.rows.push(...rows);
    return liftSpec(spec);
  };

  it("should lift a default grant that covers only some case types as one grant for each group of case types when lifting", () => {
    const result = withRows(
      { only: ["ct_a"], returns: { name: "supervisor", value: "Read" } },
      { only: ["ct_b"], returns: { name: "supervisor", value: "Own" } }
    );
    expect(result.report.differences).toEqual([]);
    expect(result.report.counts.permissions.residue).toBe(0);
    expect(result.model.defaults?.permissions?.supervisor).toEqual([
      { perms: ["Read"], only: ["ct_a"] },
      { perms: ["Own"], only: ["ct_b"] }
    ]);
  });

  it("should keep only the rows granting a role twice as rows when a role has two default grants for one case type", () => {
    const result = withRows({ returns: { name: "supervisor", value: "Read" } }, { returns: { name: "supervisor", value: "Own" } });
    expect(result.report.differences).toEqual([]);
    expect(result.report.counts.permissions.residue).toBe(2);
  });
});

describe("lifting what the services write beyond the standard columns", () => {
  it("should keep extra initiation outputs, a non-boolean or missing canReconfigure, extra configuration conditions and state-only cancellations when lifting", () => {
    const spec = base();
    const at = (kind: Kind, row: Row) => {
      const decision = spec.decisions[kind];
      if (decision === undefined) {
        throw new Error(`no ${kind}`);
      }
      decision.rows.push(row);
    };
    const initiation = spec.decisions.initiation;
    initiation?.outputs.push({ name: "workingDaysAllowed", typeRef: "integer" });
    spec.decisions.configuration?.inputs.push({ key: "toggle", typeRef: "boolean" });
    at("initiation", { when: { eventId: { in: ["extra"] } }, returns: { taskId: "Vetting", name: "Vetting", workingDaysAllowed: 5 } });
    at("configuration", { when: { taskType: { in: ["Vetting"] } }, returns: { name: "title", value: "T", canReconfigure: "true" } });
    at("configuration", { when: { taskType: { in: ["Vetting"] } }, returns: { name: "description", value: "D" } });
    at("configuration", { when: { taskType: { in: ["Vetting"] }, toggle: { in: [true] } }, returns: { name: "workType", value: "w", canReconfigure: false } });
    at("cancellation", { when: { fromState: { in: ["Closed"] } }, returns: { action: "Cancel" } });
    const result = liftSpec(spec);
    expect(result.report.differences).toEqual([]);
    expect(result.report.residue.filter((r) => r.kind !== "completion")).toEqual([]);
    const task = result.model.tasks.find((t) => t.id === "Vetting");
    expect(task?.create?.some((t) => t.outputs?.workingDaysAllowed === 5)).toBe(true);
    expect(task?.title).toEqual({ value: "T", reconfigure: "true" });
    expect(task?.description).toEqual({ value: "D", reconfigure: null });
    expect(task?.workType).toEqual(expect.arrayContaining([{ value: "w", when: { toggle: true } }]));
    expect(result.model.cancellations?.some((r) => r.events === undefined && r.fromState === "Closed")).toBe(true);
  });
});
