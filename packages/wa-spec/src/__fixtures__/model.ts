import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { importDmns } from "../importer.ts";
import type { Model, Ordering } from "../model.ts";
import { compileModel } from "../model-compile.ts";
import { parseModel, parseOrdering, stringifyModel, stringifyOrdering } from "../model-io.ts";
import { liftSpec } from "../model-lift.ts";
import type { Kind, Row, Spec } from "../schema.ts";

export const SMALL = `
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
    cancelCategory: Review
    workType: routine_work
    permissions: adminWorker
    create:
      - {event: [review, rereview]}
    reconfigure: [workType]
cancellations:
  - {events: [dispose, close], action: Cancel, categories: [Vetting, Review]}
  - {events: moved, action: Reconfigure}
`;

export const small = (): Model => parseModel(SMALL);
export const rowsOf = (model: Model, kind: Kind, ordering?: Ordering): Row[] => compileModel(model, ordering).decisions[kind]?.rows ?? [];
export const taskCell = (row: Row): string[] => (row.when?.taskType as { in: string[] } | undefined)?.in ?? [];

export const fixtures = fileURLToPath(new URL("../../test-fixtures/et", import.meta.url));
export const et = () => {
  const files = readdirSync(fixtures)
    .filter((n) => n.startsWith("wa-task-") && n.endsWith(".dmn"))
    .map((name) => ({ name, xml: readFileSync(join(fixtures, name), "utf8") }));
  const { spec } = importDmns(files, { jurisdiction: "EMPLOYMENT" });
  const { model, ordering, report } = liftSpec(spec);
  return { spec, model: parseModel(stringifyModel(model)), ordering: parseOrdering(stringifyOrdering(ordering)), report };
};

export const VARIED = `
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

export const BASE = `
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

export const configRows = (model: Model, ordering?: Parameters<typeof compileModel>[1]): Row[] =>
  compileModel(model, ordering).decisions.configuration?.rows ?? [];
export const tasksOf = (row: Row): string[] => (row.when?.taskType as { in: string[] } | undefined)?.in ?? [];

export const NULL_NAME_SPEC = {
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

export const TWO_RULES = `
kind: wa-model
version: 1
service: {slug: demo}
caseTypes: [{id: ct_a}]
tasks: []
cancellations:
  - {events: a, action: Cancel}
  - {events: b, action: Cancel}
`;

export const cfgRow = (when: Record<string, unknown>, returns: Record<string, unknown>, only?: string[], description?: string): Row =>
  ({
    ...(description === undefined ? {} : { description }),
    ...(only ? { only } : {}),
    when,
    returns
  }) as Row;

export const VARIANT_SPEC = {
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

export const MODEL = `
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

export const base = (): Spec => compileModel(parseModel(MODEL));
