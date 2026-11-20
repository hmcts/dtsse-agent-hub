import {
  type Cancellation,
  type Cond,
  categoryParts,
  type Expr,
  type Grant,
  isValEntry,
  type Model,
  ownEntry,
  permissionSpecs,
  type Task,
  type Trigger,
  type Val
} from "@hmcts-cft/wa-spec";

/*
 * What a Work Allocation model says, in words. Everything here is pure: the pages call it with a model and show its
 * strings. Names that belong to the service (fields, events, states) come out in backticks, which `textParts` splits so
 * a component can set them as code.
 */

type FriendlyCell = Trigger["event"];
type ValEntry = Extract<Val, { value: Expr }>;

const OP_WORDS = { eq: "is", ne: "is not", gt: "is more than", ge: "is at least", lt: "is less than", le: "is at most" } as const;

const code = (text: string): string => `\`${text.replace(/\s+/g, " ").trim()}\``;

const scalar = (value: string | number | boolean | null | undefined): string =>
  value === null || value === undefined ? "empty" : typeof value === "string" ? `"${value}"` : String(value);

const listOf = (items: string[], joiner: "and" | "or"): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${joiner} ${items[items.length - 1]}`;

export const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const isRawFeel = (expr: Expr | undefined): expr is { feel: string; language?: string } => isObject(expr) && "feel" in expr;

export function describeCond(cond: Cond, nested = false): string {
  if ("all" in cond || "any" in cond) {
    const parts = "all" in cond ? cond.all : cond.any;
    const text = parts.map((part) => describeCond(part, true)).join("all" in cond ? " and " : " or ");
    return nested ? `(${text})` : text;
  }
  if ("truthy" in cond) {
    return `${describeExpr(cond.truthy)} is true`;
  }
  if ("left" in cond) {
    return `${describeExpr(cond.left)} ${OP_WORDS[cond.op]} ${describeExpr(cond.right)}`;
  }
  if (cond.op === "exists") {
    return `${code(cond.field)} is set`;
  }
  if (cond.op === "notExists") {
    return `${code(cond.field)} is not set`;
  }
  return `${code(cond.field)} ${OP_WORDS[cond.op]} ${scalar(cond.value)}`;
}

export function describeExpr(expr: Expr): string {
  if (expr === null || typeof expr !== "object") {
    return scalar(expr);
  }
  if ("feel" in expr) {
    return code(expr.feel);
  }
  if ("if" in expr) {
    return `if ${describeCond(expr.if)}, then ${describeExpr(expr.use)}, otherwise ${describeExpr(expr.otherwise)}`;
  }
  if ("plus" in expr) {
    return expr.plus.map(describeExpr).join(" + ");
  }
  if ("minus" in expr) {
    return `${describeExpr(expr.minus[0])} minus ${describeExpr(expr.minus[1])}`;
  }
  if ("call" in expr) {
    return `${expr.call}(${expr.args.map(describeExpr).join(", ")})`;
  }
  if ("quantifier" in expr) {
    return `${expr.quantifier === "some" ? "some" : "every"} ${expr.variable} in ${describeExpr(expr.over)} where ${describeExpr(expr.satisfies)}`;
  }
  if ("op" in expr || "all" in expr || "any" in expr || "truthy" in expr) {
    return describeCond(expr as Cond);
  }
  return code((expr as { field: string }).field);
}

/** An expression in one short cell: a plain value as itself, anything computed as "calculated". */
export const briefExpr = (expr: Expr | undefined): string =>
  expr === undefined ? "" : expr === null ? "–" : typeof expr === "object" ? "calculated" : String(expr);

/** A plain string, when the expression is one. */
export const plainText = (expr: Expr | undefined): string | undefined => (typeof expr === "string" ? expr : undefined);

/** Splits text on its backtick spans so a component can set them as code. */
export function textParts(text: string): Array<{ text: string; code: boolean }> {
  return text
    .split("`")
    .map((part, index) => ({ text: part, code: index % 2 === 1 }))
    .filter((part) => part.text !== "");
}

const cellValues = (cell: FriendlyCell): { values: Array<string | number | boolean | null>; not: boolean } | undefined => {
  if (Array.isArray(cell)) {
    return { values: cell, not: false };
  }
  if (isObject(cell)) {
    return "in" in cell
      ? { values: cell.in as Array<string | number | boolean | null>, not: false }
      : "notIn" in cell
        ? { values: cell.notIn as Array<string | number | boolean | null>, not: true }
        : undefined;
  }
  return { values: [cell], not: false };
};

/** The names a cell matches, as a phrase: `a`, one of `a` or `b`, not `a`, or its comparison or FEEL. */
export function describeCell(cell: FriendlyCell): string {
  const listed = cellValues(cell);
  if (listed === undefined) {
    const object = cell as { cmp?: string; value?: string | number; feel?: string };
    return object.feel === undefined ? `${object.cmp} ${object.value}` : code(object.feel);
  }
  const names = listed.values.map((value) => (value === null ? "empty" : code(String(value))));
  const phrase = names.length === 1 ? (names[0] as string) : `one of ${listOf(names, "or")}`;
  return listed.not ? `not ${phrase}` : phrase;
}

/** A column condition: `referCaseTo` is `Admin`. */
export function describeColumn(column: string, cell: FriendlyCell): string {
  const listed = cellValues(cell);
  if (listed === undefined) {
    const object = cell as { cmp?: string; feel?: string; value?: string | number };
    return object.feel === undefined
      ? `${code(column)} ${OP_WORDS[object.cmp === ">" ? "gt" : object.cmp === ">=" ? "ge" : object.cmp === "<" ? "lt" : "le"]} ${object.value}`
      : `${code(column)} matches ${code(object.feel)}`;
  }
  const names = listed.values.map((value) => (value === null ? "empty" : code(String(value))));
  const verb = listed.not ? "is not" : "is";
  return names.length === 1 ? `${code(column)} ${verb} ${names[0]}` : `${code(column)} ${verb} one of ${listOf(names, "or")}`;
}

const conditions = (when: Record<string, FriendlyCell> | undefined): string =>
  Object.entries(when ?? {})
    .map(([column, cell]) => describeColumn(column, cell))
    .join(" and ");

/** "Created when `event` leaves the case in `state`, if the condition holds." */
export function describeTrigger(trigger: Trigger): string {
  const event = describeCell(trigger.event);
  let text = `Created when ${event} happens`;
  if (trigger.postState !== undefined) {
    text = `Created when ${event} leaves the case in ${describeCell(trigger.postState)}`;
  }
  const condition = conditions(trigger.when);
  if (condition !== "") {
    text += ` if ${condition}`;
  }
  if (trigger.delay !== undefined && trigger.delay !== null) {
    text += `, after a delay of ${describeExpr(trigger.delay)}`;
  }
  return text;
}

/** "Completed by `event` (auto)". */
export function describeCompletion(completion: { event: FriendlyCell; mode?: Expr }): string {
  const mode = completion.mode === undefined ? "" : ` (${typeof completion.mode === "string" ? completion.mode.toLowerCase() : describeExpr(completion.mode)})`;
  return `Completed by ${describeCell(completion.event)}${mode}`;
}

const ACTION_WORDS: Record<string, string> = { Cancel: "Cancelled", Warn: "Warns", Reconfigure: "Reconfigured" };

/** "Cancelled when `event` happens while the case is in `state` (category Vetting)". */
export function describeCancellation(rule: Cancellation): string {
  const action = typeof rule.action === "string" ? (ACTION_WORDS[rule.action] ?? rule.action) : describeExpr(rule.action);
  let text = rule.events === undefined ? `${action} on any event` : `${action} when ${describeCell(rule.events)} happens`;
  if (rule.fromState !== undefined) {
    text += ` while the case is in ${describeCell(rule.fromState)}`;
  }
  if (rule.state !== undefined) {
    text += ` while the case is in ${describeCell(rule.state)}`;
  }
  if (rule.toState !== undefined) {
    text += ` and leaves it in ${describeCell(rule.toState)}`;
  }
  const categories = (rule.categories ?? []).map(describeExpr);
  if (categories.length > 0) {
    text += ` (${categories.length === 1 ? "category" : "categories"} ${listOf(categories, "and")})`;
  }
  return text;
}

export const caseTypeIds = (model: Model): string[] => model.caseTypes.map((c) => c.id);

export const caseTypeLabel = (model: Model, id: string): string => model.caseTypes.find((c) => c.id === id)?.displayName ?? id;

/** The case types a task is for. */
export const taskCaseTypes = (model: Model, task: Task): string[] => task.only ?? caseTypeIds(model);

export interface ByCaseType<T> {
  caseTypes: string[];
  value: T;
}

/** Case types whose resolved values are identical, together, in the order the case types are listed. */
export function groupByCaseType<T>(caseTypes: string[], resolve: (caseType: string) => T): Array<ByCaseType<T>> {
  const groups: Array<ByCaseType<T> & { key: string }> = [];
  for (const caseType of caseTypes) {
    const value = resolve(caseType);
    const key = JSON.stringify(value);
    const existing = groups.find((group) => group.key === key);
    if (existing) {
      existing.caseTypes.push(caseType);
    } else {
      groups.push({ key, caseTypes: [caseType], value });
    }
  }
  return groups.map(({ caseTypes: ids, value }) => ({ caseTypes: ids, value }));
}

/** What a value is for one case type: nothing, or one expression, or several where the service repeats the row. */
export function resolveVal(val: Val | undefined, caseType: string, taskCases: string[]): Expr[] {
  const entries: Array<ValEntry | Expr> = val === undefined ? [] : Array.isArray(val) ? val : [val];
  const out: Expr[] = [];
  for (const entry of entries) {
    if (!isValEntry(entry)) {
      out.push(entry);
    } else if ((entry.only ?? taskCases).includes(caseType)) {
      const override = ownEntry(entry.overrides, caseType);
      if (override === undefined) {
        out.push(entry.value);
      } else if (override !== null) {
        out.push(isValEntry(override) ? override.value : (override as Expr));
      }
    }
  }
  return out;
}

export function resolveTriggers(model: Model, task: Task, caseType: string): Trigger[] {
  const cases = taskCaseTypes(model, task);
  return (task.create ?? []).flatMap((trigger) => {
    if (!(trigger.only ?? cases).includes(caseType)) {
      return [];
    }
    const override = ownEntry(trigger.overrides, caseType);
    return override === null ? [] : [{ ...trigger, ...override }];
  });
}

export function resolveCompletions(model: Model, task: Task, caseType: string): Array<{ event: FriendlyCell; mode?: Expr }> {
  const cases = taskCaseTypes(model, task);
  return (task.complete ?? []).flatMap((completion) => {
    if (!(completion.only ?? cases).includes(caseType)) {
      return [];
    }
    const override = ownEntry(completion.overrides, caseType);
    return override === null ? [] : [{ ...completion, ...override }];
  });
}

/** The task's name for the list: its first case type's, when that is plain text. */
export function taskName(model: Model, task: Task): string {
  const cases = taskCaseTypes(model, task);
  for (const caseType of cases) {
    const name = plainText(resolveVal(task.name, caseType, cases)[0]);
    if (name !== undefined) {
      return name;
    }
  }
  return task.id;
}

/** One case type's value of a task's attribute, in one short cell. */
export const briefVal = (val: Val | undefined, caseType: string, taskCases: string[]): string => resolveVal(val, caseType, taskCases).map(briefExpr).join(", ");

/** A value across the task's case types: the one value, or each value with the case types it is for. */
export function briefAcrossCaseTypes(model: Model, task: Task, resolve: (caseType: string) => string): string {
  const groups = groupByCaseType(taskCaseTypes(model, task), resolve).filter((group) => group.value !== "");
  const [only] = groups;
  return groups.length === 1 && only
    ? only.value
    : groups.map((group) => `${group.value} (${group.caseTypes.map((id) => caseTypeLabel(model, id)).join(", ")})`).join("; ");
}

export interface PermissionRow {
  role: string;
  category: string;
  perms: string[];
  priority: string;
  autoAssign: string;
  authorisations: string;
  caseAccessCategory: string;
  /** Where the row comes from: the task's profile, a change to it, a grant the task adds, or a grant every task has. */
  source: "profile" | "changed" | "added" | "default";
  profile?: string;
  note?: string;
}

export const permissionNames = (perms: Grant["perms"]): string[] =>
  (Array.isArray(perms) ? perms : perms.split(",")).map((perm) => perm.trim()).filter((perm) => perm !== "");

function permissionRow(model: Model, role: string, grant: Grant, source: PermissionRow["source"], profile?: string): PermissionRow {
  return {
    role,
    category: briefExpr(grant.category ?? ownEntry(model.roles, role)?.category) || "–",
    perms: permissionNames(grant.perms),
    priority: grant.priority === undefined ? "–" : briefExpr(grant.priority),
    autoAssign: grant.autoAssign === undefined ? "–" : briefExpr(grant.autoAssign),
    authorisations: grant.authorisations === undefined ? "" : briefExpr(grant.authorisations),
    caseAccessCategory: grant.caseAccessCategory === undefined ? "" : briefExpr(grant.caseAccessCategory),
    source,
    ...(profile === undefined ? {} : { profile }),
    ...(grant.note === undefined ? {} : { note: grant.note })
  };
}

/** A task's permissions for one case type: its profile with the task's own changes, then what every task has. */
export function resolvePermissions(model: Model, task: Task, caseType: string): PermissionRow[] {
  const cases = taskCaseTypes(model, task);
  const rows: PermissionRow[] = [];
  for (const spec of permissionSpecs(task)) {
    if (!(spec.only ?? cases).includes(caseType)) {
      continue;
    }
    for (const [role, grant] of Object.entries(ownEntry(model.permissionProfiles, spec.profile) ?? {})) {
      if (!spec.remove?.includes(role)) {
        const patch = ownEntry(spec.override, role);
        rows.push(permissionRow(model, role, { ...grant, ...patch }, patch === undefined ? "profile" : "changed", spec.profile));
      }
    }
    for (const [role, grant] of Object.entries(spec.add ?? {})) {
      rows.push(permissionRow(model, role, grant, "added"));
    }
  }
  for (const [role, grants] of Object.entries(model.defaults?.permissions ?? {})) {
    for (const grant of [grants].flat()) {
      if ((grant.only ?? caseTypeIds(model)).includes(caseType)) {
        rows.push(permissionRow(model, role, grant, "default"));
      }
    }
  }
  return rows;
}

/** The permission columns of a grid, in the order WA lists them, then any other a service uses. */
const PERMISSION_ORDER = [
  "Read",
  "Own",
  "Manage",
  "Claim",
  "Unclaim",
  "UnclaimAssign",
  "Assign",
  "Unassign",
  "Complete",
  "CompleteOwn",
  "Cancel",
  "Execute",
  "Refer"
];

export function permissionColumns(rows: Array<{ perms: string[] }>): string[] {
  const used = new Set(rows.flatMap((row) => row.perms));
  const known = PERMISSION_ORDER.filter((perm) => used.has(perm));
  return [...known, ...[...used].filter((perm) => !PERMISSION_ORDER.includes(perm)).sort(compare)];
}

/** The tasks whose permissions use a profile. */
export const tasksUsingProfile = (model: Model, profile: string): Task[] =>
  model.tasks.filter((task) => permissionSpecs(task).some((spec) => spec.profile === profile));

/** Roles by category, categories and roles in code point order, roles without a category last. */
export function rolesByCategory(model: Model): Array<{ category: string; roles: string[] }> {
  const groups = new Map<string, string[]>();
  for (const [role, definition] of Object.entries(model.roles ?? {})) {
    const category = briefExpr(definition.category) || "No category";
    groups.set(category, [...(groups.get(category) ?? []), role]);
  }
  return [...groups.entries()]
    .map(([category, roles]) => ({ category, roles: roles.sort(compare) }))
    .sort((a, b) => (a.category === "No category" ? 1 : b.category === "No category" ? -1 : compare(a.category, b.category)));
}

export interface CancelCategories {
  named: string[];
  /** A category that is worked out for each case, so a rule naming categories may or may not match it. */
  calculated: boolean;
}

/** The categories a task's cancellation rules find it by in one case type: its own and those of the triggers that apply there. */
export function cancelCategories(model: Model, task: Task, caseType: string): CancelCategories {
  const triggers = resolveTriggers(model, task, caseType);
  const all = (triggers.length === 0 ? [task.cancelCategory] : triggers.map((trigger) => trigger.cancelCategory ?? task.cancelCategory)).filter(
    (c): c is Expr => c !== undefined
  );
  const named = all.flatMap((category) => (typeof category === "string" ? categoryParts(category) : []));
  return { named: [...new Set(named)], calculated: all.some((category) => typeof category !== "string") };
}

export interface TaskRule {
  rule: Cancellation;
  /** The rule or the task's category is calculated, so the rule may or may not act on this task. */
  mayApply: boolean;
}

/**
 * The cancelling and warning rules that act on a task in one case type. A rule with no categories is about every task; a
 * rule or task with a calculated category may apply.
 */
export function rulesForTask(model: Model, task: Task, caseType: string): TaskRule[] {
  if (!taskCaseTypes(model, task).includes(caseType)) {
    return [];
  }
  const { named, calculated } = cancelCategories(model, task, caseType);
  return (model.cancellations ?? []).flatMap((rule): TaskRule[] => {
    if (rule.action === "Reconfigure" || !(rule.only ?? caseTypeIds(model)).includes(caseType)) {
      return [];
    }
    if (rule.categories === undefined) {
      return [{ rule, mayApply: false }];
    }
    const listed = rule.categories.flatMap((category) => (typeof category === "string" ? categoryParts(category) : []));
    if (listed.some((category) => category === "*" || named.includes(category))) {
      return [{ rule, mayApply: false }];
    }
    return calculated || rule.categories.some((category) => typeof category !== "string") ? [{ rule, mayApply: true }] : [];
  });
}

/** The rules that recalculate a case's tasks in this case type. */
export const reconfigureRules = (model: Model, caseType: string): Cancellation[] =>
  (model.cancellations ?? []).filter((rule) => rule.action === "Reconfigure" && (rule.only ?? caseTypeIds(model)).includes(caseType));

export interface BoardTask {
  task: Task;
  name: string;
  caseTypes: string[];
}

export type BoardGrouping = "roleCategory" | "workType";

/**
 * Tasks grouped by role category or work type, optionally only those of one case type. A task whose group differs by
 * case type is in each of its groups, with the case types it is there for.
 */
export function boardGroups(model: Model, by: BoardGrouping, caseType?: string): Array<{ group: string; tasks: BoardTask[] }> {
  const groups = new Map<string, BoardTask[]>();
  for (const task of model.tasks) {
    const cases = taskCaseTypes(model, task).filter((id) => caseType === undefined || id === caseType);
    for (const { caseTypes, value } of groupByCaseType(cases, (id) => briefVal(task[by], id, taskCaseTypes(model, task)))) {
      const group = value === "" ? "Not set" : value;
      groups.set(group, [...(groups.get(group) ?? []), { task, name: taskName(model, task), caseTypes }]);
    }
  }
  return [...groups.entries()]
    .map(([group, tasks]) => ({ group, tasks }))
    .sort((a, b) => (a.group === "Not set" ? 1 : b.group === "Not set" ? -1 : compare(a.group, b.group)));
}

export const DUE_LABELS: Record<string, string> = {
  days: "Due after (days)",
  origin: "Counted from",
  originRef: "Counted from (field)",
  originEarliest: "Counted from the earliest of",
  originLatest: "Counted from the latest of",
  time: "Due at (time)",
  skipNonWorkingDays: "Skip non-working days",
  nonWorkingDaysOfWeek: "Non-working days of the week",
  nonWorkingCalendar: "Non-working day calendar",
  mustBeWorkingDay: "Must fall on a working day",
  calculatedDates: "Dates calculated"
};

export const PRIORITY_LABELS: Record<string, string> = {
  major: "Major priority",
  minor: "Minor priority",
  dateOrigin: "Priority date counted from",
  dateOriginRef: "Priority date counted from (field)",
  dateOriginEarliest: "Priority date counted from the earliest of",
  dateOriginLatest: "Priority date counted from the latest of",
  dateIntervalDays: "Priority date interval (days)"
};

/** The sentence for a task's link: where in Manage Case it takes the person. */
export const describeLink = (link: { label: string; event: string; page: string }): string =>
  `"${link.label}" opens ${code(link.event)}, on page ${code(link.page)}`;

/** A cancelling or warning rule for one task, saying so when its category is calculated and it may not apply. */
export const describeTaskRule = ({ rule, mayApply }: TaskRule): string =>
  mayApply ? `${describeCancellation(rule)}. May apply: a category it names or the task's is calculated` : describeCancellation(rule);
