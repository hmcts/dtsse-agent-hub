import { z } from "zod";
import { CaseType, Cell, Expr, KINDS, Scalar, Service, Spec } from "./schema.ts";

/*
 * The task- and role-centric model: what a business analyst edits. It compiles to the table-centric spec in schema.ts,
 * which compiles to DMNs. A task, a permission profile or a cancellation rule is written once; the rows of the six
 * decision tables that carry it are derived. What the model has no place for stays in `tables`, in the spec's own form.
 */

const CaseTypeId = z.string().min(1);

/** The case types an entry is scoped to: at least one. */
const OnlyList = z.array(CaseTypeId).min(1);

/** An identifier that also appears in a row reference of the ordering file, so it has no whitespace or separators. */
export const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const Name = z.string().regex(NAME_PATTERN, "letters, digits, `_`, `.` and `-` only");

/**
 * An input entry as a person writes it: a bare value, a list of values, or the spec's cell forms (`notIn`, `cmp`,
 * `feel`). A value or list means "equals one of".
 */
export const FriendlyCell = z.union([z.string(), z.number(), z.boolean(), z.array(Scalar).min(1), Cell]);
export type FriendlyCell = z.infer<typeof FriendlyCell>;

export function decodeCell(cell: FriendlyCell): Cell {
  if (Array.isArray(cell)) {
    return { in: cell };
  }
  if (typeof cell === "object") {
    return cell;
  }
  return { in: [cell] };
}

export function encodeCell(cell: Cell): FriendlyCell {
  if ("in" in cell && cell.in.every((v) => v !== null)) {
    const [only, ...rest] = cell.in as Array<string | number | boolean>;
    return rest.length === 0 && only !== undefined ? only : cell.in;
  }
  return cell;
}

/** A value for one case type or several: the value, with `only` to scope it and `overrides` to replace it for some case types. */
export const ValEntry = z.strictObject({
  value: Expr,
  only: OnlyList.optional(),
  reconfigure: z.boolean().optional(),
  /** The description of the table row this entry heads. */
  note: z.string().optional(),
  /** A value for a case type, as itself or as `{value}` (which can be null); a null override drops the entry for that case type. */
  overrides: z.record(CaseTypeId, z.union([z.strictObject({ value: Expr }), Expr])).optional()
});
export type ValEntry = z.infer<typeof ValEntry>;

/** A configuration value: a plain value, one entry, or several entries (case type variants, or genuinely repeated rows). */
export const Val = z.union([ValEntry, z.array(z.union([ValEntry, Expr])).min(1), Expr]);
export type Val = ValEntry | Array<ValEntry | Expr> | Expr;

export const isValEntry = (value: unknown): value is ValEntry =>
  typeof value === "object" && value !== null && !Array.isArray(value) && "value" in value && !("op" in value);

/** The task configuration attributes with a place of their own in a task, by section and the DMN attribute name. */
export const DUE_ATTRIBUTES = {
  days: "dueDateIntervalDays",
  origin: "dueDateOrigin",
  originRef: "dueDateOriginRef",
  originEarliest: "dueDateOriginEarliest",
  originLatest: "dueDateOriginLatest",
  time: "dueDateTime",
  skipNonWorkingDays: "dueDateSkipNonWorkingDays",
  nonWorkingDaysOfWeek: "dueDateNonWorkingDaysOfWeek",
  nonWorkingCalendar: "dueDateNonWorkingCalendar",
  mustBeWorkingDay: "dueDateMustBeWorkingDay",
  calculatedDates: "calculatedDates"
} as const;

export const PRIORITY_ATTRIBUTES = {
  major: "majorPriority",
  minor: "minorPriority",
  dateOrigin: "priorityDateOrigin",
  dateOriginRef: "priorityDateOriginRef",
  dateOriginEarliest: "priorityDateOriginEarliest",
  dateOriginLatest: "priorityDateOriginLatest",
  dateIntervalDays: "priorityDateIntervalDays"
} as const;

export const ADDITIONAL_PREFIX = "additionalProperties_";
export const TOP_LEVEL_ATTRIBUTES = ["workType", "roleCategory", "title", "description"] as const;

const DUE_KEYS = Object.keys(DUE_ATTRIBUTES) as [keyof typeof DUE_ATTRIBUTES, ...Array<keyof typeof DUE_ATTRIBUTES>];
const PRIORITY_KEYS = Object.keys(PRIORITY_ATTRIBUTES) as [keyof typeof PRIORITY_ATTRIBUTES, ...Array<keyof typeof PRIORITY_ATTRIBUTES>];

/** A link in a task's description: the event to trigger, the page to land on and the text shown. */
export const Link = z.strictObject({ label: z.string(), event: z.string().min(1), page: z.string().min(1) });
export type Link = z.infer<typeof Link>;

export const linkText = (link: Link): string => `[${link.label}](/cases/case-details/\${[CASE_REFERENCE]}/trigger/${link.event}/${link.page})`;

export function parseLinkText(text: string): Link | undefined {
  const match = /^\[([^\]]*)\]\(\/cases\/case-details\/\$\{\[CASE_REFERENCE\]\}\/trigger\/([^/)]+)\/([^/)]+)\)$/.exec(text);
  return match ? { label: match[1] as string, event: match[2] as string, page: match[3] as string } : undefined;
}

/** One way a task comes to exist: this event, ending in this state, while the case data satisfies `when`. */
export const Trigger = z.strictObject({
  event: FriendlyCell,
  postState: FriendlyCell.optional(),
  /** Conditions on other input columns of the initiation table, by column key. */
  when: z.record(z.string(), FriendlyCell).optional(),
  /** The name the task is created with, where this trigger differs from the task's `initialName`. */
  initialName: Expr.optional(),
  delay: Expr.optional(),
  /** The category cancellation rules address, where this trigger differs from the task's `cancelCategory`. */
  cancelCategory: Expr.optional(),
  /** The description of the table row this trigger heads. */
  note: z.string().optional(),
  only: OnlyList.optional(),
  overrides: z.record(CaseTypeId, z.strictObject({ event: FriendlyCell.optional(), postState: FriendlyCell.optional() }).nullable()).optional()
});
export type Trigger = z.infer<typeof Trigger>;

export const Completion = z.strictObject({
  event: FriendlyCell,
  mode: Expr.optional(),
  /** The description of the table row this completion heads. */
  note: z.string().optional(),
  only: OnlyList.optional(),
  overrides: z.record(CaseTypeId, z.strictObject({ event: FriendlyCell.optional(), mode: Expr.optional() }).nullable()).optional()
});
export type Completion = z.infer<typeof Completion>;

/** What one role may do with a task. */
export const Grant = z.strictObject({
  perms: z.union([z.array(z.string().min(1)), z.string()]),
  /** Overrides the role's category. */
  category: Expr.optional(),
  priority: Expr.optional(),
  autoAssign: Expr.optional(),
  authorisations: Expr.optional(),
  caseAccessCategory: Expr.optional(),
  note: z.string().optional()
});
export type Grant = z.infer<typeof Grant>;

export const GrantPatch = Grant.partial();
export type GrantPatch = z.infer<typeof GrantPatch>;

/** A task's permissions: a profile, with per-task changes, for some or all of its case types. */
export const PermissionSpec = z.strictObject({
  profile: Name.optional(),
  remove: z.array(Name).optional(),
  override: z.record(Name, GrantPatch).optional(),
  add: z.record(Name, Grant).optional(),
  only: OnlyList.optional()
});
export type PermissionSpec = z.infer<typeof PermissionSpec>;

export const Task = z.strictObject({
  id: Name,
  /** The name in the task-type list. Case type variants use entries. */
  name: Val.optional(),
  /** The name the task is created with, where it differs from `name`. A trigger without one uses `name`. */
  initialName: Expr.optional(),
  only: OnlyList.optional(),
  workType: Val.optional(),
  roleCategory: Val.optional(),
  permissions: z.union([Name, PermissionSpec, z.array(PermissionSpec).min(1)]).optional(),
  create: z.array(Trigger).optional(),
  complete: z.array(Completion).optional(),
  /** The category cancellation rules use to find this task. */
  cancelCategory: Expr.optional(),
  due: z.partialRecord(z.enum(DUE_KEYS), Val).optional(),
  priority: z.partialRecord(z.enum(PRIORITY_KEYS), Val).optional(),
  title: Val.optional(),
  description: Val.optional(),
  link: Link.optional(),
  additionalProperties: z.record(Name, Val).optional(),
  /** Configuration attributes with no place of their own above, by DMN attribute name. */
  attributes: z.record(Name, Val).optional(),
  /** The attributes, by DMN name, a case change recalculates. */
  reconfigure: z.array(Name).optional()
});
export type Task = z.infer<typeof Task>;

export const Role = z.strictObject({ category: Expr.optional() });
export type Role = z.infer<typeof Role>;

/** A configuration row that applies to every task, such as the case name or the location. */
export const DefaultAttribute = z.strictObject({
  name: Name,
  value: Expr,
  reconfigure: z.boolean().optional(),
  note: z.string().optional(),
  only: OnlyList.optional()
});
export type DefaultAttribute = z.infer<typeof DefaultAttribute>;

export const Defaults = z.strictObject({
  configuration: z.array(DefaultAttribute).optional(),
  /** Grants every task has, by role. */
  permissions: z.record(Name, Grant).optional()
});
export type Defaults = z.infer<typeof Defaults>;

/** An event-driven rule: when one of these events happens, cancel (or warn about, or reconfigure) the tasks of these categories. */
export const Cancellation = z.strictObject({
  /** Names the rule in the ordering file, so adding or removing a rule does not re-point the others. */
  id: Name.optional(),
  events: FriendlyCell,
  fromState: FriendlyCell.optional(),
  state: FriendlyCell.optional(),
  action: Expr,
  warning: z.strictObject({ code: Expr.optional(), text: Expr.optional() }).optional(),
  /** The `cancelCategory` of each task it applies to; none when the action is not about particular tasks. */
  categories: z.array(Expr).min(1).optional(),
  note: z.string().optional(),
  only: OnlyList.optional()
});
export type Cancellation = z.infer<typeof Cancellation>;

export const Tables = Spec.shape.decisions;

export const Model = z.strictObject({
  kind: z.literal("wa-model"),
  version: z.literal(1),
  service: Service,
  caseTypes: z.array(CaseType).min(1),
  /** The layout file of the DMNs this model was lifted from, relative to this file. */
  layout: z.string().optional(),
  /** The ordering file that reproduces the row order and grouping of the tables, relative to this file. */
  order: z.string().optional(),
  defaults: Defaults.optional(),
  roles: z.record(Name, Role).optional(),
  permissionProfiles: z.record(Name, z.record(Name, Grant)).optional(),
  tasks: z.array(Task),
  cancellations: z.array(Cancellation).optional(),
  /** Everything the model has no place for, in the table-centric form: column definitions, helpers, hit policies and the rows that are not about one task. */
  tables: Tables.optional()
});
export type Model = z.infer<typeof Model>;

/**
 * Where each table's row order and grouping comes from. A row is a space-separated list of references to the model's entries:
 * `<task>/<slot>` for a task's entry (a configuration attribute, a role, `create`, `complete`, `type`), `*`\/<name>` for a
 * default, `!/<id>` for a cancellation rule (`!/r<hash>` when it has no `id`) and `~<hash>` for a row of the model's
 * `tables` residue. A slot with several entries adds `#<hash>` of the entry's content and case types, and `.2`, `.3` for
 * identical ones. A reference whose entry has since changed stands for the closest entry of that slot (or residue row, or
 * cancellation rule of that id) that no reference names, using the order file's `fingerprints`. A row
 * ends in `@<case types>` where it covers fewer case types than its entries. A row has the description of its first
 * entry's `note`; an object row states another (`null` for none).
 */
export const OrderRow = z.union([z.string(), z.strictObject({ row: z.string(), description: z.string().nullable() })]);
export type OrderRow = z.infer<typeof OrderRow>;

export const Ordering = z.strictObject({
  version: z.literal(1),
  rows: z.partialRecord(z.enum(KINDS), z.array(OrderRow)),
  /** What each hashed reference's entry looked like, so an edited entry is matched to its reference by closeness. */
  fingerprints: z.partialRecord(z.enum(KINDS), z.record(z.string(), z.string())).optional()
});
export type Ordering = z.infer<typeof Ordering>;

/** The entry of a user-keyed record, never one inherited from `Object.prototype`. */
export const ownEntry = <T>(record: Record<string, T> | undefined, key: string | undefined): T | undefined =>
  record && key !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;

/** A task's configuration attributes in the order they are listed and compiled, by DMN attribute name. */
export function attributesOf(task: Task): Array<[string, Val]> {
  const slots: Array<[string, Val | undefined]> = [
    ["workType", task.workType],
    ["roleCategory", task.roleCategory],
    ["title", task.title],
    ["description", task.link ? linkText(task.link) : task.description],
    ...Object.entries(DUE_ATTRIBUTES).map(([key, name]): [string, Val | undefined] => [name, task.due?.[key as keyof typeof DUE_ATTRIBUTES]]),
    ...Object.entries(PRIORITY_ATTRIBUTES).map(([key, name]): [string, Val | undefined] => [name, task.priority?.[key as keyof typeof PRIORITY_ATTRIBUTES]]),
    ...Object.entries(task.additionalProperties ?? {}).map(([key, val]): [string, Val | undefined] => [`${ADDITIONAL_PREFIX}${key}`, val]),
    ...Object.entries(task.attributes ?? {})
  ];
  return slots.filter((slot): slot is [string, Val] => slot[1] !== undefined);
}

/** A task's permissions as a list of specs: a profile name stands for that profile alone. */
export function permissionSpecs(task: Task): PermissionSpec[] {
  const permissions = task.permissions;
  if (permissions === undefined) {
    return [];
  }
  return typeof permissions === "string" ? [{ profile: permissions }] : [permissions].flat();
}

/** A category value may list several, comma separated, as the WA task templates do. */
export const categoryParts = (category: string): string[] =>
  category
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");

const RESERVED_WHEN = ["eventId", "eventID", "postEventState"];

/** Checks the references the shape alone cannot: ids, roles, profiles and case types. */
export function validateModel(model: Model): string[] {
  const problems: string[] = [];
  const caseTypes = new Set(model.caseTypes.map((c) => c.id));
  const known = (where: string, ids: string[] | undefined) => {
    for (const id of ids ?? []) {
      if (!caseTypes.has(id)) {
        problems.push(`${where}: unknown case type ${id}`);
      }
    }
  };
  const roles = new Set(Object.keys(model.roles ?? {}));
  const role = (where: string, name: string) => {
    if (!roles.has(name)) {
      problems.push(`${where}: role ${name} is not in roles`);
    }
  };
  const profiles = model.permissionProfiles ?? {};
  for (const [name, grants] of Object.entries(profiles)) {
    for (const r of Object.keys(grants)) {
      role(`profile ${name}`, r);
    }
  }
  for (const r of Object.keys(model.defaults?.permissions ?? {})) {
    role("defaults.permissions", r);
  }
  for (const [index, attribute] of (model.defaults?.configuration ?? []).entries()) {
    known(`defaults.configuration[${index}]`, attribute.only);
  }
  const ids = new Set<string>();
  for (const task of model.tasks) {
    const where = `task ${task.id}`;
    if (ids.has(task.id)) {
      problems.push(`${where}: defined twice`);
    }
    ids.add(task.id);
    known(where, task.only);
    if (task.link && task.description !== undefined) {
      problems.push(`${where}: has both a link and a description`);
    }
    const own = task.only ?? [...caseTypes];
    const scoped = (what: string, only: string[] | undefined) => {
      known(what, only);
      for (const id of only ?? []) {
        if (caseTypes.has(id) && !own.includes(id)) {
          problems.push(`${what}: ${id} is not one of the task's case types`);
        }
      }
    };
    const overridden = (what: string, keys: string[], only: string[] | undefined) => {
      known(what, keys);
      for (const id of keys) {
        if (caseTypes.has(id) && !(only ?? own).includes(id)) {
          problems.push(`${what}: ${id} is not one of the entry's case types`);
        }
      }
    };
    for (const trigger of task.create ?? []) {
      for (const key of Object.keys(trigger.when ?? {})) {
        if (RESERVED_WHEN.includes(key)) {
          problems.push(`${where} create: when names ${key}, which the trigger's event and postState set`);
        }
      }
      scoped(`${where} create`, trigger.only);
      overridden(`${where} create overrides`, Object.keys(trigger.overrides ?? {}), trigger.only);
    }
    for (const completion of task.complete ?? []) {
      scoped(`${where} complete`, completion.only);
      overridden(`${where} complete overrides`, Object.keys(completion.overrides ?? {}), completion.only);
    }
    const values: Array<[string, Val | undefined]> = [
      ["name", task.name],
      ["workType", task.workType],
      ["roleCategory", task.roleCategory],
      ["title", task.title],
      ["description", task.description],
      ...Object.entries(task.due ?? {}).map(([k, v]): [string, Val | undefined] => [`due.${k}`, v]),
      ...Object.entries(task.priority ?? {}).map(([k, v]): [string, Val | undefined] => [`priority.${k}`, v]),
      ...Object.entries(task.additionalProperties ?? {}).map(([k, v]): [string, Val | undefined] => [`additionalProperties.${k}`, v]),
      ...Object.entries(task.attributes ?? {}).map(([k, v]): [string, Val | undefined] => [`attributes.${k}`, v])
    ];
    for (const [name, val] of values) {
      for (const entry of Array.isArray(val) ? val : [val]) {
        if (isValEntry(entry)) {
          scoped(`${where} ${name}`, entry.only);
          overridden(`${where} ${name} overrides`, Object.keys(entry.overrides ?? {}), entry.only);
        }
      }
    }
    const specs = permissionSpecs(task);
    const granted = specs.map((spec) => {
      const held = new Set(Object.keys(ownEntry(profiles, spec.profile) ?? {}));
      return {
        cases: spec.only ?? own,
        held,
        roles: new Set([...[...held].filter((r) => !spec.remove?.includes(r)), ...Object.keys(spec.add ?? {})])
      };
    });
    for (const [i, a] of granted.entries()) {
      for (const b of granted.slice(i + 1)) {
        for (const r of a.roles) {
          const both = a.cases.filter((c) => b.cases.includes(c));
          if (b.roles.has(r) && both.length > 0) {
            problems.push(`${where}: permissions grant ${r} twice for ${both.join(", ")}`);
          }
        }
      }
    }
    for (const [at, spec] of specs.entries()) {
      scoped(`${where} permissions`, spec.only);
      const held = (granted[at] as { held: Set<string> }).held;
      for (const r of Object.keys(spec.override ?? {})) {
        if (spec.remove?.includes(r)) {
          problems.push(`${where}: overrides ${r}, which it also removes`);
        } else if (!held.has(r)) {
          problems.push(`${where}: overrides ${r}, which profile ${spec.profile ?? "(none)"} does not grant`);
        }
      }

      if (spec.profile !== undefined && !Object.hasOwn(profiles, spec.profile)) {
        problems.push(`${where}: unknown permission profile ${spec.profile}`);
      }
      for (const r of spec.remove ?? []) {
        if (!held.has(r)) {
          problems.push(`${where}: removes ${r}, which profile ${spec.profile ?? "(none)"} does not grant`);
        }
      }
      for (const r of Object.keys(spec.add ?? {})) {
        role(`${where} permissions`, r);
        if (held.has(r) && !spec.remove?.includes(r)) {
          problems.push(`${where}: adds ${r}, which profile ${spec.profile} already grants (override it, or remove and add it)`);
        }
      }
    }
    const attributes = attributesOf(task);
    const reconfigurable = new Set(attributes.map(([name]) => name));
    const covers = (val: Val): string[] => (Array.isArray(val) ? val : [val]).flatMap((e) => (isValEntry(e) && e.only ? e.only : own));
    for (const [i, [name, val]] of attributes.entries()) {
      for (const [other, otherVal] of attributes.slice(i + 1)) {
        const both = covers(val).filter((c) => covers(otherVal).includes(c));
        if (other === name && both.length > 0) {
          problems.push(`${where}: ${name} is defined twice for ${[...new Set(both)].join(", ")}`);
        }
      }
    }
    for (const [name, val] of attributes) {
      if (task.reconfigure?.includes(name) && (Array.isArray(val) ? val : [val]).some((e) => isValEntry(e) && e.reconfigure === false)) {
        problems.push(`${where}: ${name} is in reconfigure but an entry of it says reconfigure: false`);
      }
    }
    for (const name of task.reconfigure ?? []) {
      if (!reconfigurable.has(name)) {
        problems.push(`${where}: reconfigure names ${name}, which is not one of its attributes`);
      }
    }
  }
  const seenDefaults = new Map<string, string[]>();
  for (const [index, attribute] of (model.defaults?.configuration ?? []).entries()) {
    const cases = attribute.only ?? [...caseTypes];
    const before = seenDefaults.get(attribute.name) ?? [];
    const both = cases.filter((c) => before.includes(c));
    if (both.length > 0) {
      problems.push(`defaults.configuration[${index}]: ${attribute.name} is defined twice for ${both.join(", ")}`);
    }
    seenDefaults.set(attribute.name, [...before, ...cases]);
  }
  const used = new Set<string>();
  // Initiation rows kept in `tables` may create tasks of categories the model does not list.
  let computed = (model.tables?.initiation?.rows.length ?? 0) > 0;
  for (const task of model.tasks) {
    for (const category of [task.cancelCategory, ...(task.create ?? []).map((t) => t.cancelCategory)]) {
      if (typeof category === "string") {
        for (const part of categoryParts(category)) {
          used.add(part);
        }
      } else if (category !== undefined) {
        computed = true;
      }
    }
  }
  const ruleIds = new Set<string>();
  for (const [index, rule] of (model.cancellations ?? []).entries()) {
    known(`cancellations[${index}]`, rule.only);
    for (const category of computed ? [] : (rule.categories ?? [])) {
      for (const part of typeof category === "string" ? categoryParts(category) : []) {
        if (part !== "*" && !used.has(part)) {
          problems.push(`cancellations[${index}]: category ${part} is not the cancelCategory of any task`);
        }
      }
    }
    if (rule.id !== undefined) {
      if (ruleIds.has(rule.id)) {
        problems.push(`cancellations[${index}]: id ${rule.id} is used by another rule`);
      }
      ruleIds.add(rule.id);
    }
  }
  return problems;
}
