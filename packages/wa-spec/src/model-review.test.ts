import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { importDmns } from "./importer.ts";
import type { Model } from "./model.ts";
import { compileModel } from "./model-compile.ts";
import { loadSpecFile, loadSpecOnly, orderPathBeside, parseModel, stringifyModel, stringifyOrdering } from "./model-io.ts";
import { liftSpec } from "./model-lift.ts";
import type { Row } from "./schema.ts";
import { compareSpecs, diffSpecs } from "./spec-diff.ts";
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
    cancelCategory: X
    create: [{event: a}]
    attributes: {custom: [{value: 1, only: [ct_a]}, {value: 2, only: [ct_b]}]}
    complete: [{event: done}]
  - {id: B, create: [{event: b}], cancelCategory: Y}
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
    expect(loadSpecFile(join(dir, "n.yaml")).spec.decisions.initiation?.rows).toHaveLength(2);
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

describe("round two", () => {
  const files = readdirSync(fileURLToPath(new URL("../test-fixtures/et", import.meta.url)))
    .filter((n) => n.startsWith("wa-task-") && n.endsWith(".dmn"))
    .map((name) => ({ name, xml: readFileSync(join(fileURLToPath(new URL("../test-fixtures/et", import.meta.url)), name), "utf8") }));
  const { spec } = importDmns(files, { jurisdiction: "EMPLOYMENT" });
  const lifted = liftSpec(spec);
  const model = parseModel(stringifyModel(lifted.model));

  it("should write the model without anchors and aliases when two values are equal", () => {
    expect(stringifyModel(lifted.model)).not.toMatch(/&a\d|\*a\d/);
    expect(stringifyOrdering(lifted.ordering)).not.toMatch(/&a\d|\*a\d/);
  });

  it("should keep a row's place when one entry of a repeated slot is edited", () => {
    const task = model.tasks.find((t) => t.id === "ReviewRule21Referral") as Model["tasks"][number];
    const entries = task.roleCategory as unknown[];
    expect(Array.isArray(entries)).toBe(true);
    const edited = {
      ...model,
      tasks: model.tasks.map((t) => (t === task ? { ...t, roleCategory: [entries[0], { value: "ADMIN", only: ["et_scotland"] }] } : t))
    } as Model;
    const before = configRows(model, lifted.ordering);
    const after = configRows(edited, lifted.ordering);
    const place = (rows: Row[], value: string) =>
      rows.findIndex(
        (r) => r.returns?.name === "roleCategory" && r.returns?.value === value && tasksOf(r).includes("ReviewRule21Referral") && r.only?.[0] === "et_scotland"
      );
    expect(after.length).toBe(before.length + 1);
    const was = place(before, "LEGAL_OPERATIONS");
    expect(was).toBeGreaterThan(-1);
    expect(place(after, "ADMIN")).toBeGreaterThanOrEqual(was);
    expect(place(after, "ADMIN")).toBeLessThanOrEqual(was + 1);
  });

  it("should keep a cancellation rule's rows in place when its events are edited", () => {
    const rules = (model.cancellations ?? []).map((r, i) => (i === 0 ? { ...r, events: ["disposeCase", "extra"] } : r));
    const before = compileModel(model, lifted.ordering).decisions.cancellation?.rows ?? [];
    const after = compileModel({ ...model, cancellations: rules }, lifted.ordering).decisions.cancellation?.rows ?? [];
    expect(after).toHaveLength(before.length);
    expect(after.map((r) => r.returns?.processCategories)).toEqual(before.map((r) => r.returns?.processCategories));
    expect(after[0]?.when).toEqual({ event: { in: ["disposeCase", "extra"] } });
  });

  it("should reject a reconfigure name the task has no attribute for when validating", () => {
    expect(() => parseModel(BASE.replace("workType: w1", "workType: w1\n    reconfigure: [title]"))).toThrow("reconfigure names title");
    expect(() => parseModel(BASE.replace("workType: w1", "workType: w1\n    reconfigure: [workType, custom]"))).not.toThrow();
  });

  it("should reject an override for a case type the entry does not cover when validating", () => {
    const text = BASE.replace("workType: w1", "workType: {value: w1, only: [ct_a], overrides: {ct_b: w2}}");
    expect(() => parseModel(text)).toThrow("workType overrides: ct_b is not one of the entry's case types");
    const task = BASE.replace("complete: [{event: done}]", "complete: [{event: done, overrides: {ct_c: null}}]");
    expect(() => parseModel(task)).toThrow("complete overrides: ct_c is not one of the entry's case types");
  });

  it("should compare models without reading their layout when diffing", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-spec-diff-"));
    writeFileSync(join(dir, "m.yaml"), `${BASE}layout: missing.layout.yaml\n`);
    expect(loadSpecOnly(join(dir, "m.yaml")).decisions.configuration?.rows.length).toBeGreaterThan(0);
  });
});

const STALE_SPEC = {
  version: 1 as const,
  service: { slug: "x" },
  caseTypes: [{ id: "A" }, { id: "B" }, { id: "C" }],
  decisions: {
    configuration: {
      name: "c",
      hitPolicy: "COLLECT" as const,
      inputs: [
        { key: "caseData", typeRef: "string" },
        { key: "taskType", typeRef: "string" }
      ],
      outputs: [
        { name: "name", typeRef: "string" },
        { name: "value", typeRef: "string" },
        { name: "canReconfigure", typeRef: "boolean" }
      ],
      rows: [
        { only: ["A"], when: { taskType: { in: ["t1"] } }, returns: { name: "title", value: "same", canReconfigure: false } },
        { only: ["C"], when: { taskType: { in: ["t1"] } }, returns: { name: "title", value: "other", canReconfigure: false } },
        { only: ["B"], when: { taskType: { in: ["t1"] } }, returns: { name: "title", value: "same", canReconfigure: false } },
        { when: { taskType: { in: ["t1"] } }, returns: { name: "workType", value: "w", canReconfigure: false } }
      ]
    }
  }
};

describe("round three", () => {
  it("should keep every row naming a stale token in place when an entry shared by several rows is edited", () => {
    const { model, ordering, report } = liftSpec(STALE_SPEC);
    expect(report.differences).toEqual([]);
    const entries = model.tasks[0]?.title as Array<{ value: string }>;
    for (const entry of entries) {
      if (entry.value === "same") {
        entry.value = "changed";
      }
    }
    const rows = compileModel(model, ordering).decisions.configuration?.rows ?? [];
    expect(rows.map((r) => `${r.only?.join("") ?? "*"}:${r.returns?.value}`)).toEqual(["A:changed", "C:other", "B:changed", "*:w"]);
  });

  it("should leave an atom for a later token when an earlier stale token's case types do not overlap it", () => {
    const model = parseModel(`
kind: wa-model
version: 1
service: {slug: demo}
caseTypes: [{id: ct_a}, {id: ct_b}, {id: ct_c}]
tasks:
  - {id: A, only: [ct_a], workType: [{value: w, only: [ct_a]}, {value: v, only: [ct_a]}]}
  - {id: Z, only: [ct_a], title: z}
`);
    const ordering = { version: 1 as const, rows: { configuration: ["A/workType#dead1 @ct_c", "A/workType#dead2 @ct_a", "Z/title"] } };
    const rows = configRows(model, ordering);
    expect(rows.map((r) => r.returns?.name)).toEqual(["workType", "title", "workType"]);
    expect(rows.map((r) => r.returns?.value)).toEqual(["w", "z", "v"]);
  });

  it("should reject one attribute defined in two fields of a task for the same case types when validating", () => {
    const task = (attributes: string, extra = "") => BASE.replace("attributes: {custom:", `${extra}attributes: {${attributes}, custom:`);
    expect(() => parseModel(task("workType: w2"))).toThrow("workType is defined twice for ct_a, ct_b");
    expect(() => parseModel(task("dueDateIntervalDays: 2", "due: {days: 1}\n    "))).toThrow("dueDateIntervalDays is defined twice");
    expect(() => parseModel(task("additionalProperties_x: 2", "additionalProperties: {x: 1}\n    "))).toThrow("additionalProperties_x is defined twice");
    expect(() => parseModel(task("workType: {value: w2, only: [ct_c]}"))).toThrow("task's case types");
  });

  it("should reject two permission specs granting one role for the same case type when validating", () => {
    const text = (second: string) => `
kind: wa-model
version: 1
service: {slug: demo}
caseTypes: [{id: ct_a}, {id: ct_b}]
roles: {admin: {}}
permissionProfiles: {p: {admin: {perms: [Read]}}}
tasks:
  - id: A
    permissions:
      - {profile: p, only: [ct_a]}
      - {add: {admin: {perms: [Own]}}${second}}
`;
    expect(() => parseModel(text(""))).toThrow("permissions grant admin twice for ct_a");
    expect(() => parseModel(text(", only: [ct_b]"))).not.toThrow();
  });

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

  it("should name the ordering file beside a model by the one rule when building its path", () => {
    expect(orderPathBeside("out/model.yaml")).toBe("out/model.order.yaml");
    expect(orderPathBeside("out/model.yml")).toBe("out/model.order.yaml");
  });
});

const NULL_NAME_SPEC = {
  version: 1 as const,
  service: { slug: "x" },
  caseTypes: [{ id: "A" }],
  decisions: {
    initiation: {
      name: "i",
      hitPolicy: "COLLECT" as const,
      inputs: [{ key: "eventId", typeRef: "string" }],
      outputs: [
        { name: "taskId", typeRef: "string" },
        { name: "name", typeRef: "string" },
        { name: "processCategories", typeRef: "string" }
      ],
      rows: [
        { when: { eventId: { in: ["e1"] } }, returns: { taskId: "T", name: "N", processCategories: "C" } },
        { when: { eventId: { in: ["e2"] } }, returns: { taskId: "T", name: "N", processCategories: "C" } },
        { when: { eventId: { in: ["e3"] } }, returns: { taskId: "T", name: null, processCategories: null } }
      ]
    }
  }
};

const TWO_RULES = `
kind: wa-model
version: 1
service: {slug: demo}
caseTypes: [{id: ct_a}]
tasks: []
cancellations:
  - {events: a, action: Cancel}
  - {events: b, action: Cancel}
`;

describe("round four", () => {
  it("should keep an explicit null name and category on one trigger when the other triggers share a value", () => {
    const lifted = liftSpec(NULL_NAME_SPEC);
    expect(lifted.report.differences).toEqual([]);
    expect(lifted.model.tasks[0]?.create?.[2]).toMatchObject({ initialName: null, cancelCategory: null });
    expect(compileModel(lifted.model, lifted.ordering).decisions.initiation?.rows[2]?.returns).toEqual({ taskId: "T", name: null, processCategories: null });
  });

  it("should compare rows as sets when the diff ignores rule order", () => {
    const a = compileModel(parseModel(BASE));
    const b = structuredClone(a);
    b.decisions.cancellation?.rows.reverse();
    expect(compareSpecs(a, b).total).toBeGreaterThan(0);
    expect(compareSpecs(a, b, { ignoreRuleOrder: true }).total).toBe(0);
  });

  it("should reject a cancellation id used by two rules when validating", () => {
    expect(() => parseModel(TWO_RULES.replace("{events: a,", "{id: x, events: a,").replace("{events: b,", "{id: x, events: b,"))).toThrow(
      "id x is used by another rule"
    );
  });

  it("should reject an override of a removed role and an add of a role the profile grants when validating", () => {
    const text = (spec: string) => `
kind: wa-model
version: 1
service: {slug: demo}
caseTypes: [{id: ct_a}]
roles: {admin: {}}
permissionProfiles: {p: {admin: {perms: [Read]}}}
tasks: [{id: A, permissions: ${spec}}]
`;
    expect(() => parseModel(text("{profile: p, remove: [admin], override: {admin: {priority: 1}}}"))).toThrow("overrides admin, which it also removes");
    expect(() => parseModel(text("{profile: p, add: {admin: {perms: [Own]}}}"))).toThrow("adds admin, which profile p already grants");
    expect(() => parseModel(text("{profile: p, remove: [admin], add: {admin: {perms: [Own]}}}"))).not.toThrow();
  });

  it("should reject an entry that says reconfigure false when the task lists the attribute as reconfigurable", () => {
    const text = BASE.replace("workType: w1", "workType: {value: w1, reconfigure: false}\n    reconfigure: [workType]");
    expect(() => parseModel(text)).toThrow("workType is in reconfigure but an entry of it says reconfigure: false");
  });

  it("should reject role fields the model does not use when parsing", () => {
    expect(() => parseModel(BASE.replace("roles: {admin: {}}", "roles: {admin: {type: CASE}}"))).toThrow();
  });
});

const cfgRow = (when: Record<string, unknown>, returns: Record<string, unknown>, only?: string[], description?: string): Row =>
  ({
    ...(description === undefined ? {} : { description }),
    ...(only ? { only } : {}),
    when,
    returns
  }) as Row;

const VARIANT_SPEC = {
  version: 1 as const,
  service: { slug: "x" },
  caseTypes: [{ id: "ct_a" }, { id: "ct_b" }, { id: "ct_c" }],
  decisions: {
    configuration: {
      name: "c",
      hitPolicy: "COLLECT" as const,
      inputs: [
        { key: "caseData", typeRef: "string" },
        { key: "taskType", typeRef: "string" }
      ],
      outputs: [
        { name: "name", typeRef: "string" },
        { name: "value", typeRef: "string" },
        { name: "canReconfigure", typeRef: "boolean" }
      ],
      rows: [
        cfgRow({ taskType: { in: ["A"] } }, { name: "title", value: "x", canReconfigure: false }, ["ct_a"]),
        cfgRow({ taskType: { in: ["M"] } }, { name: "title", value: "m", canReconfigure: false }, ["ct_a", "ct_b"]),
        cfgRow({ taskType: { in: ["A"] } }, { name: "title", value: "y", canReconfigure: false }, ["ct_b"]),
        cfgRow({ taskType: { in: ["Z"] } }, { name: "title", value: "z", canReconfigure: false }, ["ct_a", "ct_b"], "the last one")
      ]
    }
  }
};

describe("round five", () => {
  it("should match a stale token to the closest entry when one variant is deleted and another edited", () => {
    const { model, ordering, report } = liftSpec(VARIANT_SPEC);
    expect(report.differences).toEqual([]);
    const a = model.tasks.find((t) => t.id === "A") as Model["tasks"][number];
    const edited = { ...model, tasks: model.tasks.map((t) => (t === a ? { ...t, title: { value: "y2", only: ["ct_b"] } } : t)) } as Model;
    const rows = configRows(edited, ordering).map((r) => r.returns?.value);
    expect(rows).toEqual(["m", "y2", "z"]);
  });

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

  it("should compare rows as sets only where the hit policy allows when diffing without a flag", () => {
    const a = compileModel(parseModel(BASE));
    const b = structuredClone(a);
    for (const spec of [a, b]) {
      (spec.decisions.cancellation as { hitPolicy: string }).hitPolicy = "UNIQUE";
    }
    b.decisions.cancellation?.rows.reverse();
    expect(compareSpecs(a, b).total).toBe(0);
    expect(compareSpecs(a, b, { strict: true }).total).toBeGreaterThan(0);
    expect(diffSpecs(a, b).length).toBeGreaterThan(0);
    (a.decisions.cancellation as { hitPolicy: string }).hitPolicy = "COLLECT";
    (b.decisions.cancellation as { hitPolicy: string }).hitPolicy = "COLLECT";
    expect(compareSpecs(a, b).total).toBeGreaterThan(0);
  });

  it("should not take a name inherited from Object.prototype for a profile when validating", () => {
    const text = BASE.replace("workType: w1", "workType: w1\n    permissions: constructor");
    expect(() => parseModel(text)).toThrow("unknown permission profile constructor");
  });

  it("should export the model entry points and not its internals when imported from the package index", async () => {
    const api = await import("./index.ts");
    expect(typeof api.liftSpec).toBe("function");
    expect(typeof api.compileModel).toBe("function");
    expect(typeof api.loadSpecFile).toBe("function");
    expect("collectAtoms" in api).toBe(false);
    expect("attributesOf" in api).toBe(false);
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

describe("readable errors", () => {
  it("should name the file and the field when a model fails its schema when loading", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-spec-err-"));
    writeFileSync(join(dir, "bad.yaml"), "kind: wa-model\nversion: 1\nservice: {}\ncaseTypes: []\ntasks: []\n");
    expect(() => loadSpecFile(join(dir, "bad.yaml"))).toThrow(/bad\.yaml is not valid:[\s\S]*service\.slug/);
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

  it("should keep residue rows in place when an earlier residue row is deleted", () => {
    const hasCase = (key: string) => ({ caseData: { feel: key } });
    const spec = structuredClone(VARIANT_SPEC);
    spec.decisions.configuration.rows = [
      cfgRow(hasCase("a"), { name: "title", value: "r1", canReconfigure: false }),
      cfgRow(hasCase("b"), { name: "title", value: "r2", canReconfigure: false }),
      cfgRow({ taskType: { in: ["t1"] } }, { name: "workType", value: "w", canReconfigure: false }),
      cfgRow(hasCase("c"), { name: "title", value: "r3", canReconfigure: false })
    ] as never;
    const { model, ordering, report } = liftSpec(spec);
    expect(report.differences).toEqual([]);
    expect(report.counts.configuration.residue).toBe(3);
    const rows = model.tables?.configuration?.rows ?? [];
    const edited = { ...model, tables: { ...model.tables, configuration: { ...model.tables?.configuration, rows: rows.slice(1) } } } as Model;
    const values = configRows(edited, ordering).map((r) => r.returns?.value);
    expect(values).toEqual(["r2", "w", "r3"]);
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

  it("should report an inserted row as inserted and not every later row as different when diffing specs", () => {
    const a = compileModel(parseModel(BASE));
    const b = structuredClone(a);
    const rows = b.decisions.cancellation?.rows as Row[];
    rows.splice(1, 0, { when: { event: { in: ["new"] } }, returns: { action: "Cancel" } });
    const { differences, total } = compareSpecs(a, b, { strict: true });
    expect(total).toBe(1);
    expect(differences[0]).toContain("spec.decisions.cancellation.rows[1]: inserted");
  });

  it("should show the rows of a task when given a model", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-spec-show-"));
    writeFileSync(join(dir, "m.yaml"), BASE);
    const shown = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./cli.ts", import.meta.url)), "show", join(dir, "m.yaml"), "A"], {
      encoding: "utf8",
      cwd: fileURLToPath(new URL("..", import.meta.url))
    });
    expect(shown.status).toBe(0);
    expect(shown.stdout).toContain("workType");
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
  const model = parseModel(stringifyModel(lifted.model));

  it("should append a new cancellation rule and not give it a deleted rule's place when a rule is deleted and another added", () => {
    const kept = (model.cancellations ?? []).filter((r) => r.id !== "Cancel-gone");
    const edited = { ...model, cancellations: [...kept, { id: "NewRule", events: "new", action: "Cancel", categories: ["X"] }] } as Model;
    const rows = compileModel(edited, lifted.ordering).decisions.cancellation?.rows ?? [];
    expect(rows.map((r) => JSON.stringify(r.when?.event))).toEqual(['{"in":["moved"]}', '{"in":["new"]}']);
  });

  it("should reject a when key that the trigger's event or postState sets when validating", () => {
    const text = BASE.replace("create: [{event: a}]", "create: [{event: a, when: {postEventState: Open}}]");
    expect(() => parseModel(text)).toThrow("create: when names postEventState");
  });

  it("should reject a cancellation category no task uses, except a wildcard or when a category is computed", () => {
    expect(() => parseModel(BASE.replace("categories: [X, Y]", "categories: [X, Z]"))).toThrow("category Z is not the cancelCategory of any task");
    expect(() => parseModel(BASE.replace("categories: [X, Y]", 'categories: [X, "*"]'))).not.toThrow();
    expect(() =>
      parseModel(BASE.replace("categories: [X, Y]", "categories: [X, Z]").replace("cancelCategory: Y", "cancelCategory: {feel: 'x'}"))
    ).not.toThrow();
  });

  it("should reject an empty only list when parsing", () => {
    expect(() => parseModel(BASE.replace("only: [ct_a, ct_b]", "only: []"))).toThrow();
  });

  it("should reject a default configuration defined twice for the same case types when validating", () => {
    const defaults = (second: string) =>
      BASE.replace("tasks:", `defaults:\n  configuration:\n    - {name: caseName, value: a}\n    - {name: caseName, value: b${second}}\ntasks:`);
    expect(() => parseModel(defaults(""))).toThrow("caseName is defined twice for ct_a, ct_b, ct_c");
    expect(() => parseModel(defaults(", only: [ct_a]"))).toThrow("defined twice for ct_a");
  });

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

  it("should accept comma separated categories on a task and on a rule when validating", () => {
    const text = (task: string, rule: string) =>
      BASE.replace("cancelCategory: X", `cancelCategory: ${task}`).replace("categories: [X, Y]", `categories: [${rule}, Y]`);
    expect(() => parseModel(text('"caseProgression,followUpOverdue"', "caseProgression"))).not.toThrow();
    expect(() => parseModel(text('"caseProgression, followUpOverdue"', '"followUpOverdue,caseProgression"'))).not.toThrow();
    expect(() => parseModel(text('"caseProgression,followUpOverdue"', "other"))).toThrow("category other is not the cancelCategory of any task");
  });

  it("should keep the description of a row shared by several tasks when the first task is deleted", () => {
    const without = { ...model, tasks: model.tasks.filter((t) => t.id !== "Et1Vetting") } as Model;
    const rows = configRows(without, lifted.ordering).filter((r) => r.returns?.name === "workType" && r.returns?.value === "routine_work");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => typeof r.description === "string" && r.description.includes("type of work"))).toBe(true);
    expect(rows.some((r) => tasksOf(r).includes("Et1Vetting"))).toBe(false);
  });

  it("should keep a task's workType bare when the description of its shared row is in the ordering", () => {
    expect(model.tasks.find((t) => t.id === "Et1Vetting")?.workType).toBe("routine_work");
  });

  it("should leave every row where it was when a cancellation rule is renamed", () => {
    const renamed = { ...model, cancellations: (model.cancellations ?? []).map((r, i) => (i === 0 ? { ...r, id: "renamed" } : r)) } as Model;
    expect(diffSpecs(spec, compileModel(renamed, lifted.ordering))).toEqual([]);
  });

  it("should name the ordering file once in the error when a model's ordering file is missing, and when it is invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-spec-order-"));
    writeFileSync(join(dir, "m.yaml"), `${BASE}order: gone.order.yaml\n`);
    let message = "";
    try {
      loadSpecFile(join(dir, "m.yaml"));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.split(join(dir, "m.yaml")).length - 1).toBe(1);
    writeFileSync(join(dir, "bad.order.yaml"), "version: 2\n");
    writeFileSync(join(dir, "n.yaml"), `${BASE}order: bad.order.yaml\n`);
    expect(() => loadSpecFile(join(dir, "n.yaml"))).toThrow(/bad\.order\.yaml is not valid/);
  });
});
