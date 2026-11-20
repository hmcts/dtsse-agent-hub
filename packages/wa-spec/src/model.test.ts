import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BASE, MODEL, TWO_RULES } from "./__fixtures__/model.ts";
import { importDmns } from "./importer.ts";
import { decodeCell, encodeCell } from "./model.ts";
import { compileModel } from "./model-compile.ts";
import { parseModel, stringifyModel } from "./model-io.ts";
import { liftSpec } from "./model-lift.ts";

describe("cell codec", () => {
  it("should read a bare value or a list as an in-list and write one value back bare when it round-trips", () => {
    expect(decodeCell("a")).toEqual({ in: ["a"] });
    expect(decodeCell(["a", "b"])).toEqual({ in: ["a", "b"] });
    expect(encodeCell({ in: ["a"] })).toBe("a");
    expect(encodeCell({ in: ["a", "b"] })).toEqual(["a", "b"]);
    expect(encodeCell({ notIn: ["a"] })).toEqual({ notIn: ["a"] });
  });
});

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

describe("reconfigure names and override case types", () => {
  const files = readdirSync(fileURLToPath(new URL("../test-fixtures/et", import.meta.url)))
    .filter((n) => n.startsWith("wa-task-") && n.endsWith(".dmn"))
    .map((name) => ({ name, xml: readFileSync(join(fileURLToPath(new URL("../test-fixtures/et", import.meta.url)), name), "utf8") }));
  const { spec } = importDmns(files, { jurisdiction: "EMPLOYMENT" });
  const lifted = liftSpec(spec);
  const _model = parseModel(stringifyModel(lifted.model));

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
});

describe("duplicate attributes and permission grants", () => {
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
});

describe("cancellation ids, removed roles and unused fields", () => {
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

describe("profile names and package exports", () => {
  it("should not take a name inherited from Object.prototype for a profile when validating", () => {
    const text = BASE.replace("workType: w1", "workType: w1\n    permissions: constructor");
    expect(() => parseModel(text)).toThrow("unknown permission profile constructor");
  });

  it("should export the model entry points and the helpers the builder pages read, but not collectAtoms when imported from the package index", async () => {
    const api = await import("./index.ts");
    expect(typeof api.liftSpec).toBe("function");
    expect(typeof api.compileModel).toBe("function");
    expect(typeof api.loadSpecFile).toBe("function");
    expect("collectAtoms" in api).toBe(false);
    expect(typeof api.attributesOf).toBe("function");
  });
});

describe("trigger keys, categories, only lists and duplicate defaults", () => {
  const lifted = liftSpec(compileModel(parseModel(BASE)));
  const _model = parseModel(stringifyModel(lifted.model));

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
});

describe("comma separated categories", () => {
  const fixtures = fileURLToPath(new URL("../test-fixtures/et", import.meta.url));
  const files = readdirSync(fixtures)
    .filter((n) => n.startsWith("wa-task-") && n.endsWith(".dmn"))
    .map((name) => ({ name, xml: readFileSync(join(fixtures, name), "utf8") }));
  const { spec } = importDmns(files, { jurisdiction: "EMPLOYMENT" });
  const lifted = liftSpec(spec);
  const _model = parseModel(stringifyModel(lifted.model));

  it("should accept comma separated categories on a task and on a rule when validating", () => {
    const text = (task: string, rule: string) =>
      BASE.replace("cancelCategory: X", `cancelCategory: ${task}`).replace("categories: [X, Y]", `categories: [${rule}, Y]`);
    expect(() => parseModel(text('"caseProgression,followUpOverdue"', "caseProgression"))).not.toThrow();
    expect(() => parseModel(text('"caseProgression, followUpOverdue"', '"followUpOverdue,caseProgression"'))).not.toThrow();
    expect(() => parseModel(text('"caseProgression,followUpOverdue"', "other"))).toThrow("category other is not the cancelCategory of any task");
  });
});

describe("loading a model with a layout of its own", () => {
  const _dir = mkdtempSync(join(tmpdir(), "wa-spec-model-io-"));

  it("should reject a model whose references are broken when parsing it", () => {
    expect(() => parseModel(MODEL.replace("profile: p", "profile: nope"))).toThrow("Invalid model");
  });
});
