import { byCodePoint, majority } from "./merge.ts";
import {
  ADDITIONAL_PREFIX,
  type Cancellation,
  categoryParts,
  DUE_ATTRIBUTES,
  encodeCell,
  type Grant,
  type GrantPatch,
  linkText,
  type Model,
  NAME_PATTERN,
  type Ordering,
  type OrderRow,
  type PermissionSpec,
  PRIORITY_ATTRIBUTES,
  parseLinkText,
  type Task,
  type Trigger,
  type Val,
  type ValEntry
} from "./model.ts";
import {
  ALL_TASKS,
  type Atom,
  type Content,
  collectAtoms,
  compileModel,
  inCaseOrder,
  overlapping,
  RULES,
  residueRefs,
  rowFingerprint,
  stable,
  withCanonicalEvent
} from "./model-compile.ts";
import { type Cell, type Decision, type Expr, KINDS, type Kind, type Row, type Spec } from "./schema.ts";
import { compareSpecs } from "./spec-diff.ts";

export interface KindCount {
  rows: number;
  lifted: number;
  residue: number;
}

export interface LiftReport {
  counts: Record<Kind, KindCount>;
  /** Rows of every table that are about no one task and stay in the table form, with why. */
  residue: Array<{ kind: Kind; row: number; reason: string }>;
  tasks: number;
  profiles: number;
  roles: number;
  /** Rows lifted into `defaults` rather than a task. */
  defaultRows: number;
  /** Differences between the spec and what the lifted model compiles back to; empty when the lift is lossless. */
  differences: string[];
  /** How many differences there are in all; `differences` holds the first few. */
  totalDifferences: number;
}

export interface LiftResult {
  model: Model;
  ordering: Ordering;
  report: LiftReport;
}

export interface LiftOptions {
  layout?: string;
  order?: string;
}

interface Item {
  row: number;
  task: string;
  bucket: string;
  content: Content;
  cases: string[];
}

interface Classified {
  items: Item[];
  /** The row's `only`, or every case type. */
  cases: string[];
}

const isName = (value: unknown): value is string => typeof value === "string" && NAME_PATTERN.test(value);
const subset = (a: string[], b: string[]) => a.every((x) => b.includes(x));
const sameSet = (a: string[], b: string[]) => a.length === b.length && subset(a, b);
const onlyKeys = (value: object, allowed: string[]) => Object.keys(value).every((k) => allowed.includes(k));

interface Ent<T> {
  data: T;
  /** `stable(data)`, computed once. */
  key: string;
  cases: string[];
  /** The description of the table row this entry heads. */
  note?: string;
}

/** Adds an entry, folding it into an identical one for other case types when there is one. */
function addEntry<T>(list: Array<Ent<T>>, data: T, cases: string[]): Ent<T> {
  const key = stable(data);
  const same = list.find((e) => e.key === key && !overlapping(e.cases, cases));
  if (same) {
    same.cases = [...same.cases, ...cases];
    return same;
  }
  const added = { data, key, cases: [...cases] };
  list.push(added);
  return added;
}

interface TriggerData {
  event: Cell;
  postState?: Cell;
  extras: Record<string, Cell>;
  name?: Expr;
  delay?: Expr;
  category?: Expr;
}

interface CompletionData {
  event: Cell;
  mode?: Expr;
}

interface AttrData {
  value: Expr;
  reconfigure: boolean;
}

interface TaskAcc {
  id: string;
  names: Array<Ent<Expr>>;
  triggers: Array<Ent<TriggerData>>;
  completions: Array<Ent<CompletionData>>;
  attrs: Map<string, Array<Ent<AttrData>>>;
  grants: Map<string, Array<Ent<Grant>>>;
}

function grantOf(returns: Record<string, Expr>, description: string | undefined): Grant | undefined {
  const value = returns.value;
  if (typeof value !== "string") {
    return undefined;
  }
  const parts = value.split(", ");
  const perms = value !== "" && parts.every((p) => p !== "") ? parts : value;
  return {
    perms,
    ...("roleCategory" in returns ? { category: returns.roleCategory as Expr } : {}),
    ...("assignmentPriority" in returns ? { priority: returns.assignmentPriority as Expr } : {}),
    ...("autoAssignable" in returns ? { autoAssign: returns.autoAssignable as Expr } : {}),
    ...("authorisations" in returns ? { authorisations: returns.authorisations as Expr } : {}),
    ...("caseAccessCategory" in returns ? { caseAccessCategory: returns.caseAccessCategory as Expr } : {}),
    ...(description === undefined ? {} : { note: description })
  };
}

/** Explains why a row is not about one task, or lifts it into items. */
function classify(kind: Kind, row: Row, index: number, caseIds: string[]): Classified | string {
  let cases = caseIds;
  if (row.only !== undefined) {
    const ordered = inCaseOrder(caseIds, row.only);
    if (row.only.length === 0 || !row.only.every((c, i) => c === ordered[i]) || ordered.length === caseIds.length) {
      return "its case types are not a proper subset in the spec's case type order";
    }
    cases = ordered;
  }
  const when = withCanonicalEvent(kind, row.when ?? {});
  const returns = row.returns ?? {};
  const make = (task: string, slot: string, content: Content): Item => ({
    row: index,
    task,
    bucket: task === RULES ? RULES : `${task}/${slot}`,
    content,
    cases
  });
  const tasksOf = (key: string): string[] | string | undefined => {
    const cell = when[key];
    if (cell === undefined) {
      return undefined;
    }
    if (!("in" in cell) || !cell.in.every(isName)) {
      return `its ${key} is not a plain list of task ids`;
    }
    return cell.in as string[];
  };
  switch (kind) {
    case "initiation": {
      if (!when.eventId) {
        return "it has no event";
      }
      if (!isName(returns.taskId)) {
        return "it does not create a task with a plain task id";
      }
      if (!onlyKeys(returns, ["taskId", "name", "delayDuration", "processCategories"])) {
        return "it returns columns a task trigger has no place for";
      }
      return { cases, items: [make(returns.taskId, "create", { when: { ...when }, returns: { ...returns } })] };
    }
    case "configuration": {
      const tasks = tasksOf("taskType");
      if (typeof tasks === "string") {
        return tasks;
      }
      if (!onlyKeys(when, ["taskType"])) {
        return "it has conditions beyond the task type";
      }
      if (!isName(returns.name) || !("value" in returns) || typeof returns.canReconfigure !== "boolean" || Object.keys(returns).length !== 3) {
        return "it is not an attribute name, a value and a reconfigure flag";
      }
      const content: Content = { when: {}, returns: { ...returns } };
      return { cases, items: (tasks ?? [ALL_TASKS]).map((task) => make(task, returns.name as string, content)) };
    }
    case "permissions": {
      const tasks = tasksOf("taskType");
      if (typeof tasks === "string") {
        return tasks;
      }
      if (!onlyKeys(when, ["taskType"])) {
        return "it has conditions beyond the task type";
      }
      if (
        !isName(returns.name) ||
        !onlyKeys(returns, ["caseAccessCategory", "name", "value", "roleCategory", "authorisations", "assignmentPriority", "autoAssignable"])
      ) {
        return "it is not a role's grant";
      }
      if (!grantOf(returns, row.description)) {
        return "its permissions are not a plain list";
      }
      const content: Content = { when: {}, returns: { ...returns }, ...(row.description === undefined ? {} : { description: row.description }) };
      return { cases, items: (tasks ?? [ALL_TASKS]).map((task) => make(task, returns.name as string, content)) };
    }
    case "completion": {
      const event = when.eventID;
      if (!event || !onlyKeys(when, ["eventID"])) {
        return "it has no event, or conditions beyond it";
      }
      if (!isName(returns.taskType) || !onlyKeys(returns, ["taskType", "completionMode"])) {
        return "it completes no task";
      }
      return { cases, items: [make(returns.taskType, "complete", { when: { eventID: event }, returns: { ...returns } })] };
    }
    case "allowed-days":
      return "the model has no place for allowed days";
    case "task-types": {
      if (Object.keys(when).length > 0 || !isName(returns.taskTypeId) || !("taskTypeName" in returns) || !onlyKeys(returns, ["taskTypeId", "taskTypeName"])) {
        return "it is not a task type and its name";
      }
      return { cases, items: [make(returns.taskTypeId, "type", { when: {}, returns: { ...returns } })] };
    }
    case "cancellation": {
      if (
        !when.event ||
        !onlyKeys(when, ["fromState", "event", "state"]) ||
        !returns.action ||
        !onlyKeys(returns, ["action", "warningCode", "warningText", "processCategories"])
      ) {
        return "it is not an event, an action and optionally a category";
      }
      return {
        cases,
        items: [make(RULES, "", { when: { ...when }, returns: { ...returns }, ...(row.description === undefined ? {} : { description: row.description }) })]
      };
    }
  }
}

const ROLE_CATEGORY_WORDS: Record<string, string> = {
  ADMIN: "admin",
  CTSC: "ctsc",
  LEGAL_OPERATIONS: "legalOps",
  JUDICIAL: "judicial",
  CASEWORKER: "caseworker"
};

const camel = (text: string): string =>
  ROLE_CATEGORY_WORDS[text] ??
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

interface GrantSet {
  roles: Array<[string, Grant]>;
}

const setKey = (set: GrantSet): string => stable([...set.roles].sort(([a], [b]) => byCodePoint(a, b)));

/** How a task's grants differ from a profile, in the terms of a permission spec, and how many changes that takes. */
function deltaFrom(profile: Record<string, Grant>, set: GrantSet): { spec: PermissionSpec; cost: number } {
  const target = new Map(set.roles);
  const remove: string[] = [];
  const override: Record<string, GrantPatch> = {};
  const add: Record<string, Grant> = {};
  for (const [role, base] of Object.entries(profile)) {
    const next = target.get(role);
    if (!next) {
      remove.push(role);
    } else if (stable(next) !== stable(base)) {
      if (Object.keys(base).every((k) => k in next)) {
        override[role] = Object.fromEntries(Object.entries(next).filter(([k, v]) => stable((base as Record<string, unknown>)[k]) !== stable(v))) as GrantPatch;
      } else {
        remove.push(role);
        add[role] = next;
      }
    }
  }
  for (const [role, grant] of set.roles) {
    if (!Object.hasOwn(profile, role)) {
      add[role] = grant;
    }
  }
  const cost = remove.length + Object.keys(override).length + Object.keys(add).length;
  return {
    spec: {
      ...(remove.length > 0 ? { remove } : {}),
      ...(Object.keys(override).length > 0 ? { override } : {}),
      ...(Object.keys(add).length > 0 ? { add } : {})
    },
    cost
  };
}

interface LeafEntry {
  value: Expr;
  cases: string[];
  reconfigure: boolean;
  note?: string;
}

/** A configuration value as the model writes it: bare when it applies to all of the task's case types, else with its scope. */
function leaf(entries: LeafEntry[], taskCases: string[], uniform: boolean): Val {
  const rendered = entries.map((entry): Expr | ValEntry => {
    const scoped = !sameSet(entry.cases, taskCases);
    const explicit = entry.reconfigure && !uniform;
    if (!scoped && !explicit && entry.note === undefined) {
      return entry.value;
    }
    return {
      value: entry.value,
      ...(entry.note === undefined ? {} : { note: entry.note }),
      ...(scoped ? { only: entry.cases } : {}),
      ...(explicit ? { reconfigure: true } : {})
    };
  });
  return rendered.length === 1 ? (rendered[0] as Val) : (rendered as Val);
}

const DUE_BY_NAME = new Map(Object.entries(DUE_ATTRIBUTES).map(([k, v]) => [v, k]));
const PRIORITY_BY_NAME = new Map(Object.entries(PRIORITY_ATTRIBUTES).map(([k, v]) => [v, k]));

/**
 * Lifts a table-centric spec into the task- and role-centric model, with the ordering file that makes compiling it
 * reproduce the spec's tables row for row. Rows about no one task stay in `tables`. The result is checked by compiling
 * it again: `report.differences` is empty when nothing was lost.
 */
export function liftSpec(spec: Spec, options: LiftOptions = {}): LiftResult {
  const caseIds = spec.caseTypes.map((c) => c.id);
  const tasks = new Map<string, TaskAcc>();
  const getTask = (id: string): TaskAcc => {
    let acc = tasks.get(id);
    if (!acc) {
      acc = { id, names: [], triggers: [], completions: [], attrs: new Map(), grants: new Map() };
      tasks.set(id, acc);
    }
    return acc;
  };
  const defaultsConfig: Array<Ent<{ name: string; value: Expr; reconfigure: boolean }>> = [];
  const defaultGrants = new Map<string, Array<Ent<Grant>>>();
  const cancellationRows: Array<{ row: number; classified: Classified; src: Row }> = [];

  const residue = Object.fromEntries(KINDS.map((kind) => [kind, [] as Row[]])) as Record<Kind, Row[]>;
  const reasons: LiftReport["residue"] = [];
  const classified = {} as Record<Kind, Array<{ row: Row; index: number; result: Classified | string; residueIndex?: number }>>;

  for (const kind of KINDS) {
    const decision = spec.decisions[kind];
    classified[kind] = (decision?.rows ?? []).map((row, i) => ({ row, index: i + 1, result: classify(kind, row, i + 1, caseIds) }));
  }

  // A role granted twice to one task for the same case type cannot be a profile entry, so rows granting it stay as rows.
  const seenGrants = new Map<string, string[]>();
  const twiceGranted = new Map<string, string>();
  let permissionsStay: string | undefined;
  for (const entry of classified.permissions) {
    if (typeof entry.result !== "string") {
      for (const item of entry.result.items) {
        const key = item.bucket;
        if (overlapping(seenGrants.get(key) ?? [], item.cases)) {
          twiceGranted.set(key, `${item.task} is granted ${item.content.returns.name as string} twice for one case type`);
        }
        seenGrants.set(key, [...(seenGrants.get(key) ?? []), ...item.cases]);
      }
    }
  }

  // A default grant is one per role and covers every case type, so any other shape of one keeps permissions as rows.
  const defaultGrantRows = new Map<string, number>();
  for (const entry of classified.permissions) {
    if (typeof entry.result !== "string") {
      for (const item of entry.result.items.filter((i) => i.task === ALL_TASKS)) {
        const role = item.content.returns.name as string;
        defaultGrantRows.set(role, (defaultGrantRows.get(role) ?? 0) + 1);
        if (item.cases.length !== caseIds.length || (defaultGrantRows.get(role) ?? 0) > 1) {
          permissionsStay ??= `the default grant of ${role} is not one grant for every case type`;
        }
      }
    }
  }

  // A trigger with no name would take the task type's name when compiled, so such rows stay as rows.
  const typed = new Set(classified["task-types"].flatMap((e) => (typeof e.result === "string" ? [] : e.result.items.map((i) => i.task))));
  // A cancellation rule for a category no task creates (its tasks were deleted) would fail the model's own check, so its row stays a row.
  const created = new Set<string>();
  let computedCategory = false;
  for (const entry of classified.initiation) {
    for (const item of typeof entry.result === "string" ? [] : entry.result.items) {
      const category = item.content.returns.processCategories;
      if (typeof category === "string") {
        for (const part of categoryParts(category)) {
          created.add(part);
        }
      } else if (category !== undefined) {
        computedCategory = true;
      }
    }
  }
  const staleCategory = (result: Classified): string | undefined => {
    const category = result.items[0]?.content.returns.processCategories;
    const unknown =
      !computedCategory &&
      classified.initiation.every((e) => typeof e.result !== "string") &&
      typeof category === "string" &&
      categoryParts(category).find((part) => part !== "*" && !created.has(part));
    return unknown ? `no task is created with the category ${unknown}` : undefined;
  };
  for (const kind of KINDS) {
    for (const entry of classified[kind]) {
      const result = entry.result;
      const twice = typeof result === "string" || kind !== "permissions" ? undefined : result.items.map((i) => twiceGranted.get(i.bucket)).find(Boolean);
      const unnamed =
        kind === "initiation" && typeof result !== "string" && result.items.some((i) => !("name" in i.content.returns) && typed.has(i.task))
          ? "it creates a task with no name, but the task type has one"
          : undefined;
      const failure =
        typeof result === "string" ? result : kind === "permissions" ? (permissionsStay ?? twice) : kind === "cancellation" ? staleCategory(result) : unnamed;
      if (typeof result === "string" || failure !== undefined) {
        residue[kind].push(entry.row);
        entry.residueIndex = residue[kind].length;
        reasons.push({ kind, row: entry.index, reason: failure ?? "" });
        continue;
      }
      const { items, cases } = result;
      if (kind === "cancellation") {
        cancellationRows.push({ row: entry.index, classified: result, src: entry.row });
        continue;
      }
      for (const [position, item] of items.entries()) {
        const returns = item.content.returns;
        const acc = item.task === ALL_TASKS ? undefined : getTask(item.task);
        let added: Ent<unknown> | undefined;
        if (kind === "initiation" && acc) {
          const { eventId, postEventState, ...extras } = item.content.when;
          added = addEntry(
            acc.triggers,
            {
              event: eventId as Cell,
              ...(postEventState ? { postState: postEventState } : {}),
              extras,
              ...("name" in returns ? { name: returns.name as Expr } : {}),
              ...("delayDuration" in returns ? { delay: returns.delayDuration as Expr } : {}),
              ...("processCategories" in returns ? { category: returns.processCategories as Expr } : {})
            },
            cases
          );
        } else if (kind === "task-types" && acc) {
          added = addEntry(acc.names, returns.taskTypeName as Expr, cases);
        } else if (kind === "completion" && acc) {
          added = addEntry(
            acc.completions,
            { event: item.content.when.eventID as Cell, ...("completionMode" in returns ? { mode: returns.completionMode as Expr } : {}) },
            cases
          );
        } else if (kind === "configuration") {
          const data = { value: returns.value as Expr, reconfigure: returns.canReconfigure as boolean };
          if (acc) {
            const list = acc.attrs.get(returns.name as string) ?? [];
            acc.attrs.set(returns.name as string, list);
            added = addEntry(list, data, cases);
          } else {
            added = addEntry(defaultsConfig, { name: returns.name as string, ...data }, cases);
          }
        } else if (kind === "permissions") {
          const grant = grantOf(returns, item.content.description) as Grant;
          const role = returns.name as string;
          const target = acc ? acc.grants : defaultGrants;
          const list = target.get(role) ?? [];
          target.set(role, list);
          addEntry(list, grant, cases);
        }
        // The description of a row shared by several tasks belongs to the row, so the ordering states it; a row of one entry has it as that entry's note.
        if (added && position === 0 && items.length === 1 && entry.row.description !== undefined) {
          added.note ??= entry.row.description;
        }
      }
    }
  }

  // Roles: a role's category is stated once when every grant of it agrees.
  const roleGrants = new Map<string, Grant[]>();
  for (const acc of [...tasks.values()]) {
    for (const [role, list] of acc.grants) {
      roleGrants.set(role, [...(roleGrants.get(role) ?? []), ...list.map((e) => e.data)]);
    }
  }
  for (const [role, list] of defaultGrants) {
    roleGrants.set(role, [...(roleGrants.get(role) ?? []), ...list.map((e) => e.data)]);
  }
  const roles: NonNullable<Model["roles"]> = {};
  for (const [role, grants] of roleGrants) {
    const first = grants[0]?.category;
    const agree = first !== undefined && grants.every((g) => stable(g.category) === stable(first));
    roles[role] = agree ? { category: first } : {};
    if (agree) {
      for (const g of grants) {
        delete g.category;
      }
    }
  }

  // Permission profiles: tasks whose grants are identical share one.
  type Group = { cases: string[]; set: GrantSet; key: string };
  const groupsOf = (acc: TaskAcc): Group[] => {
    const cases = caseIds.filter((c) => [...acc.grants.values()].some((list) => list.some((e) => e.cases.includes(c))));
    const groups: Group[] = [];
    for (const c of cases) {
      const roleList: Array<[string, Grant]> = [];
      for (const [role, list] of acc.grants) {
        const entry = list.find((e) => e.cases.includes(c));
        if (entry) {
          roleList.push([role, entry.data]);
        }
      }
      const set = { roles: roleList };
      const key = setKey(set);
      const same = groups.find((g) => g.key === key);
      if (same) {
        same.cases.push(c);
      } else {
        groups.push({ cases: [c], set, key });
      }
    }
    return groups;
  };
  const taskGroups = new Map([...tasks.values()].map((acc) => [acc.id, groupsOf(acc)] as const));
  const usage = new Map<string, { set: GrantSet; tasks: Set<string> }>();
  for (const [id, groups] of taskGroups) {
    for (const group of groups) {
      const key = group.key;
      const used = usage.get(key) ?? { set: group.set, tasks: new Set<string>() };
      used.tasks.add(id);
      usage.set(key, used);
    }
  }
  const profiles: Record<string, Record<string, Grant>> = {};
  const profileOf = new Map<string, string>();
  for (const [key, used] of usage) {
    if (used.tasks.size < 2) {
      continue;
    }
    const categories = used.set.roles
      .filter(([, g]) => g.autoAssign === true)
      .map(([role, g]) => g.category ?? roles[role]?.category)
      .filter((c): c is string => typeof c === "string" && c !== "")
      .map(camel);
    const base = categories.length > 0 ? `${[...new Set(categories)].map((c, i) => (i === 0 ? c : capitalised(c))).join("And")}Worker` : undefined;
    let name = base ?? `profile${Object.keys(profiles).length + 1}`;
    for (let n = 2; Object.hasOwn(profiles, name); n++) {
      name = `${base ?? "profile"}${n}`;
    }
    profiles[name] = Object.fromEntries(used.set.roles);
    profileOf.set(key, name);
  }

  // Tasks.
  const allCasesOf = (acc: TaskAcc): string[] => {
    const used = new Set<string>();
    const lists: Array<Array<Ent<unknown>>> = [acc.names, acc.triggers, acc.completions, ...acc.attrs.values(), ...acc.grants.values()];
    for (const list of lists) {
      for (const entry of list) {
        for (const c of entry.cases) {
          used.add(c);
        }
      }
    }
    return caseIds.filter((c) => used.has(c));
  };
  const ordered = <T>(entry: Ent<T>): string[] => inCaseOrder(caseIds, entry.cases);

  const modelTasks: Task[] = [...tasks.values()].map((acc) => {
    const taskCases = allCasesOf(acc);
    const scoped = (entry: Ent<unknown>): { only?: string[] } => (sameSet(entry.cases, taskCases) ? {} : { only: ordered(entry) });
    const task: Record<string, unknown> = { id: acc.id };

    if (acc.names.length > 0) {
      task.name = leaf(
        acc.names.map((e) => ({ value: e.data, cases: ordered(e), reconfigure: false, ...(e.note === undefined ? {} : { note: e.note }) })),
        taskCases,
        true
      );
    }
    const initialNames = acc.triggers.map((e) => e.data.name);
    const categories = acc.triggers.map((e) => e.data.category);
    const uniform = <T>(values: Array<T | undefined>): T | undefined =>
      values.length > 0 && values.every((v) => v !== undefined)
        ? majority(
            (values as T[]).map((value) => ({ caseType: "", value })),
            stable
          ).base
        : undefined;
    const taskName = uniform(initialNames);
    const taskCategory = uniform(categories);
    const names = acc.names;
    const plain = names.length === 1 && names[0] && sameSet(names[0].cases, taskCases) && names[0].note === undefined ? names[0].data : undefined;
    if (taskName !== undefined && !(plain !== undefined && stable(plain) === stable(taskName))) {
      task.initialName = taskName;
    }
    if (taskCases.length < caseIds.length) {
      task.only = taskCases;
    }

    // Configuration.
    const reconfigure: string[] = [];
    const attribute = (name: string): Val | undefined => {
      const list = acc.attrs.get(name);
      if (!list) {
        return undefined;
      }
      const all = list.every((e) => e.data.reconfigure);
      const none = list.every((e) => !e.data.reconfigure);
      if (all) {
        reconfigure.push(name);
      }
      return leaf(
        list.map((e) => ({ value: e.data.value, cases: ordered(e), reconfigure: e.data.reconfigure, ...(e.note === undefined ? {} : { note: e.note }) })),
        taskCases,
        all || none
      );
    };
    const taken = new Set<string>();
    const put = (target: Record<string, unknown>, key: string, name: string) => {
      const value = attribute(name);
      if (value !== undefined) {
        target[key] = value;
        taken.add(name);
      }
    };
    for (const key of ["workType", "roleCategory"]) {
      put(task, key, key);
    }

    // Permissions.
    const groups = taskGroups.get(acc.id) ?? [];
    const specs = groups.map((group): PermissionSpec => {
      const name = profileOf.get(group.key);
      const scope = sameSet(group.cases, taskCases) ? {} : { only: group.cases };
      if (name) {
        return { profile: name, ...scope };
      }
      let best: { name: string; spec: PermissionSpec; cost: number } | undefined;
      for (const [profileName, profile] of Object.entries(profiles)) {
        const delta = deltaFrom(profile, group.set);
        if (!best || delta.cost < best.cost) {
          best = { name: profileName, ...delta };
        }
      }
      if (best && best.cost <= 2 && best.cost < group.set.roles.length) {
        return { profile: best.name, ...best.spec, ...scope };
      }
      return { add: Object.fromEntries(group.set.roles), ...scope };
    });
    if (specs.length > 0) {
      const only = specs[0] as PermissionSpec;
      task.permissions = specs.length === 1 && only.profile !== undefined && Object.keys(only).length === 1 ? only.profile : specs.length === 1 ? only : specs;
    }

    // Triggers, completion, category.
    if (acc.triggers.length > 0) {
      task.create = acc.triggers.map((e): Trigger => {
        const d = e.data;
        const extras = Object.fromEntries(Object.entries(d.extras).map(([k, v]) => [k, encodeCell(v)]));
        return {
          event: encodeCell(d.event),
          ...(d.postState ? { postState: encodeCell(d.postState) } : {}),
          ...(Object.keys(extras).length > 0 ? { when: extras } : {}),
          ...(d.name !== undefined && stable(d.name) !== stable(taskName) ? { initialName: d.name } : {}),
          ...(d.delay !== undefined ? { delay: d.delay } : {}),
          ...(d.category !== undefined && stable(d.category) !== stable(taskCategory) ? { cancelCategory: d.category } : {}),
          ...(e.note === undefined ? {} : { note: e.note }),
          ...scoped(e)
        };
      });
    }
    if (taskCategory !== undefined) {
      task.cancelCategory = taskCategory;
    }
    if (acc.completions.length > 0) {
      task.complete = acc.completions.map((e) => ({
        event: encodeCell(e.data.event),
        ...(e.data.mode !== undefined ? { mode: e.data.mode } : {}),
        ...(e.note === undefined ? {} : { note: e.note }),
        ...scoped(e)
      }));
    }

    const section = (names: Map<string, string>, target: string) => {
      const out: Record<string, unknown> = {};
      for (const [name, key] of names) {
        put(out, key, name);
      }
      if (Object.keys(out).length > 0) {
        task[target] = out;
      }
    };
    section(DUE_BY_NAME as Map<string, string>, "due");
    section(PRIORITY_BY_NAME as Map<string, string>, "priority");
    put(task, "title", "title");
    const description = acc.attrs.get("description");
    if (description) {
      const only = description.length === 1 ? description[0] : undefined;
      const link =
        only && typeof only.data.value === "string" && only.note === undefined && sameSet(only.cases, taskCases) ? parseLinkText(only.data.value) : undefined;
      if (only && link && linkText(link) === only.data.value) {
        task.link = link;
        taken.add("description");
        if (only.data.reconfigure) {
          reconfigure.push("description");
        }
      } else {
        put(task, "description", "description");
      }
    }
    const additional: Record<string, unknown> = {};
    const other: Record<string, unknown> = {};
    for (const name of acc.attrs.keys()) {
      if (taken.has(name)) {
        continue;
      }
      if (name.startsWith(ADDITIONAL_PREFIX) && isName(name.slice(ADDITIONAL_PREFIX.length))) {
        put(additional, name.slice(ADDITIONAL_PREFIX.length), name);
      } else {
        put(other, name, name);
      }
    }
    if (Object.keys(additional).length > 0) {
      task.additionalProperties = additional;
    }
    if (Object.keys(other).length > 0) {
      task.attributes = other;
    }
    if (reconfigure.length > 0) {
      task.reconfigure = reconfigure;
    }
    return orderTask(task) as Task;
  });

  // Defaults.
  const defaults: NonNullable<Model["defaults"]> = {};
  if (defaultsConfig.length > 0) {
    defaults.configuration = defaultsConfig.map((e) => ({
      name: e.data.name,
      value: e.data.value,
      ...(e.data.reconfigure ? { reconfigure: true } : {}),
      ...(e.note === undefined ? {} : { note: e.note }),
      ...(sameSet(e.cases, caseIds) ? {} : { only: ordered(e) })
    }));
  }
  if (defaultGrants.size > 0) {
    defaults.permissions = Object.fromEntries([...defaultGrants].map(([role, list]) => [role, (list[0] as Ent<Grant>).data]));
  }

  // Cancellation rules: adjacent rows that differ only in category share a rule.
  const rules: Cancellation[] = [];
  const ruleOfRow = new Map<number, number>();
  let previous: { key: string; row: number } | undefined;
  for (const { row, classified: result, src } of cancellationRows) {
    const item = result.items[0] as Item;
    const { processCategories, ...returns } = item.content.returns;
    const key = stable([item.content.when, returns, item.content.description, src.only]);
    const category = "processCategories" in item.content.returns ? processCategories : undefined;
    const when = item.content.when;
    if (previous && previous.key === key && previous.row === row - 1 && category !== undefined && rules.at(-1)?.categories) {
      rules.at(-1)?.categories?.push(category as Expr);
    } else {
      rules.push({
        events: encodeCell(when.event as Cell),
        ...(when.fromState ? { fromState: encodeCell(when.fromState) } : {}),
        ...(when.state ? { state: encodeCell(when.state) } : {}),
        action: returns.action as Expr,
        ...("warningCode" in returns || "warningText" in returns
          ? {
              warning: {
                ...("warningCode" in returns ? { code: returns.warningCode as Expr } : {}),
                ...("warningText" in returns ? { text: returns.warningText as Expr } : {})
              }
            }
          : {}),
        ...(category !== undefined ? { categories: [category as Expr] } : {}),
        ...(item.content.description === undefined ? {} : { note: item.content.description }),
        ...(src.only ? { only: src.only } : {})
      });
    }
    ruleOfRow.set(row, rules.length - 1);
    previous = { key, row };
  }

  const taken = new Set<string>();
  const cancellations: Cancellation[] = rules.map((rule) => {
    const words = [rule.action, ...[rule.events].flat()].filter((w): w is string => typeof w === "string").slice(0, 2);
    const base = words.join("-").replace(/[^A-Za-z0-9_.-]/g, "") || "rule";
    let id = base;
    for (let n = 2; taken.has(id); n++) {
      id = `${base}-${n}`;
    }
    taken.add(id);
    return { id, ...rule };
  });

  const tables: NonNullable<Model["tables"]> = {};
  for (const kind of KINDS) {
    const decision = spec.decisions[kind];
    if (decision) {
      tables[kind] = { ...decision, rows: residue[kind] } as Decision;
    }
  }

  const model: Model = {
    kind: "wa-model",
    version: 1,
    service: spec.service,
    caseTypes: spec.caseTypes,
    ...(options.layout ? { layout: options.layout } : {}),
    ...(options.order ? { order: options.order } : {}),
    ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
    roles,
    ...(Object.keys(profiles).length > 0 ? { permissionProfiles: profiles } : {}),
    tasks: modelTasks,
    ...(cancellations.length > 0 ? { cancellations } : {}),
    tables
  };

  // The ordering file: for each row of each table, which entries of the model it was made of.
  const atoms = collectAtoms(model);
  const ordering: Ordering = { version: 1, rows: {} };
  let unmatched: string | undefined;
  const fingerprints: NonNullable<Ordering["fingerprints"]> = {};
  const remember = (kind: Kind, ref: string, print: string) => {
    const own = fingerprints[kind] ?? {};
    own[ref] = print;
    fingerprints[kind] = own;
  };
  for (const kind of KINDS) {
    if (!spec.decisions[kind]) {
      continue;
    }
    const buckets = new Map<string, Atom[]>();
    for (const atom of atoms[kind]) {
      const key = `${atom.task}/${atom.slot}`;
      buckets.set(key, [...(buckets.get(key) ?? []), atom]);
    }
    const residueRef = residueRefs(residue[kind]);
    const used = new Map<Atom, string[]>();
    const rows: OrderRow[] = [];
    for (const entry of classified[kind]) {
      if (entry.residueIndex !== undefined) {
        const ref = residueRef[entry.residueIndex - 1] as string;
        remember(kind, ref, rowFingerprint(entry.row, caseIds));
        rows.push(ref);
        continue;
      }
      const result = entry.result as Classified;
      const tokens: string[] = [];
      const matched: Atom[] = [];
      let differs = false;
      for (const item of result.items) {
        const wanted = stable(item.content);
        const bucket = kind === "cancellation" ? `${RULES}/${cancellations[ruleOfRow.get(entry.index) ?? 0]?.id}` : item.bucket;
        const atom = (buckets.get(bucket) ?? []).find(
          (a) => a.contentKey === wanted && subset(item.cases, a.cases) && !overlapping(used.get(a) ?? [], item.cases)
        );
        if (!atom) {
          unmatched ??= `${kind} row ${entry.index}: no model entry for ${bucket}`;
          continue;
        }
        used.set(atom, [...(used.get(atom) ?? []), ...item.cases]);
        tokens.push(atom.ref);
        matched.push(atom);
        if (atom.ref.includes("#") || kind === "cancellation") {
          remember(kind, atom.ref, atom.fingerprint);
        }
        differs ||= !sameSet(atom.cases, result.cases);
      }
      const text = [...tokens, ...(differs ? [`@${result.cases.join(",")}`] : [])].join(" ");
      const keepsNote = kind === "permissions" || kind === "cancellation";
      const described = keepsNote || matched[0]?.note === entry.row.description;
      rows.push(described ? text : { row: text, description: entry.row.description ?? null });
    }
    ordering.rows[kind] = rows;
  }

  if (Object.keys(fingerprints).length > 0) {
    ordering.fingerprints = fingerprints;
  }
  const counts = Object.fromEntries(
    KINDS.map((kind) => [kind, { rows: classified[kind].length, lifted: classified[kind].length - residue[kind].length, residue: residue[kind].length }])
  ) as Record<Kind, KindCount>;
  let found = { differences: [] as string[], total: 0 };
  try {
    found = unmatched ? { differences: [unmatched], total: 1 } : compareSpecs(spec, compileModel(model, ordering, atoms), { strict: true });
  } catch (error) {
    found = { differences: [(error as Error).message], total: 1 };
  }
  return {
    model,
    ordering,
    report: {
      counts,
      residue: reasons,
      tasks: modelTasks.length,
      profiles: Object.keys(profiles).length,
      roles: Object.keys(roles).length,
      defaultRows: (defaults.configuration?.length ?? 0) + Object.keys(defaults.permissions ?? {}).length,
      differences: found.differences,
      totalDifferences: found.total
    }
  };
}

const TASK_KEY_ORDER = [
  "id",
  "name",
  "initialName",
  "only",
  "workType",
  "roleCategory",
  "permissions",
  "create",
  "complete",
  "cancelCategory",
  "due",
  "priority",
  "title",
  "description",
  "link",
  "additionalProperties",
  "attributes",
  "reconfigure"
];

function orderTask(task: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(TASK_KEY_ORDER.filter((k) => task[k] !== undefined).map((k) => [k, task[k]]));
}

export function renderLiftReport(report: LiftReport, service: string): string {
  const lines = [
    `# Lift report: ${service}`,
    "",
    `${report.tasks} tasks, ${report.profiles} permission profiles, ${report.roles} roles, ${report.defaultRows} rows of service-wide defaults.`,
    ""
  ];
  lines.push("## Rows by table", "", "| Table | Rows | In the model | In the residue |", "| --- | ---: | ---: | ---: |");
  let rows = 0;
  let lifted = 0;
  for (const kind of KINDS) {
    const c = report.counts[kind];
    rows += c.rows;
    lifted += c.lifted;
    lines.push(`| ${kind} | ${c.rows} | ${c.lifted} | ${c.residue} |`);
  }
  lines.push(`| total | ${rows} | ${lifted} | ${rows - lifted} |`, "");
  lines.push("## Not lifted", "");
  if (report.residue.length === 0) {
    lines.push("Every row is in the model. Column definitions, helper decisions, dependencies and hit policies stay in `tables`.", "");
  } else {
    for (const r of report.residue) {
      lines.push(`- ${r.kind} row ${r.row}: ${r.reason}`);
    }
    lines.push("");
  }
  lines.push("## Check", "");
  lines.push(
    report.differences.length === 0
      ? "The model compiles back to the original table spec with no difference, row order included."
      : `The model does not compile back to the original:\n\n${report.differences.map((d) => `- ${d}`).join("\n")}`
  );
  return `${lines.join("\n")}\n`;
}
