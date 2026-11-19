import type { Cell, Expr, Kind, Row, Spec } from "./schema.ts";
import { toYaml } from "./spec-io.ts";

/** Which column of each kind names the task a row is about. */
const TASK_COLUMN: Record<Kind, { side: "when" | "returns"; name: string }> = {
  initiation: { side: "returns", name: "taskId" },
  configuration: { side: "when", name: "taskType" },
  permissions: { side: "when", name: "taskType" },
  completion: { side: "returns", name: "taskType" },
  cancellation: { side: "returns", name: "processCategories" },
  "task-types": { side: "returns", name: "taskTypeId" },
  "allowed-days": { side: "when", name: "taskId" }
};

export interface TaskRows {
  kind: Kind;
  /** `mayApply` marks a row whose task cell is FEEL, which may or may not match the task. */
  rows: Array<{ index: number; row: Row; mayApply?: true }>;
}

type Match = "yes" | "maybe" | "no";

/** Whether a structured value can give a result the spec does not spell out, such as a field read, in some branch. */
const canBeRead = (value: Expr | undefined): boolean =>
  typeof value === "object" && value !== null && ("if" in value ? canBeRead(value.use) || canBeRead(value.otherwise) : true);

/** The process categories a task is created with: `sure` ones come from rows that name it, `possible` ones from rows that may. */
interface Categories {
  sure: Set<string>;
  possible: Set<string>;
}

/** Whether a cancellation row's process categories include one the task is created with; an empty cell is every category. */
const cancels = (value: Expr | undefined, categories: Categories): Match => {
  if (value === undefined) {
    return "yes";
  }
  const listedValues = typeof value === "string" ? listed(value) : categoriesOf(value);
  const structured = typeof value === "object" && value !== null;
  if (!structured && listedValues.some((c) => categories.sure.has(c))) {
    return "yes";
  }
  const overlaps = listedValues.some((c) => categories.sure.has(c) || categories.possible.has(c));
  return overlaps || (structured && ("feel" in value || canBeRead(value))) ? "maybe" : "no";
};

/** Every string in a structured expression, which is where a task id or process category would be written. */
const literalsOf = (value: unknown): string[] =>
  typeof value === "string" ? [value] : typeof value === "object" && value !== null ? Object.values(value).flatMap(literalsOf) : [];

const quoted = (text: string): string[] => [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1] as string);

/** Process categories are written as comma-separated lists, which the case event handler splits. */
const listed = (text: string): string[] =>
  text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

/** The process categories a value may give: a string, the quoted strings of FEEL, or the strings of a structured expression, each split on commas. */
const categoriesOf = (value: Expr | undefined): string[] =>
  (typeof value === "object" && value !== null && "feel" in value ? quoted(value.feel) : literalsOf(value)).flatMap(listed);

/** Whether an output value names the task: a scalar or FEEL text does, and a structured expression with the id somewhere in it may. */
const mentions = (value: Expr | undefined, taskId: string): Match => {
  if (typeof value === "string") {
    return value === taskId ? "yes" : "no";
  }
  if (typeof value === "object" && value !== null && "feel" in value) {
    return value.feel.trim() === `"${taskId}"` ? "yes" : "maybe";
  }
  return literalsOf(value).includes(taskId) || canBeRead(value) ? "maybe" : "no";
};

/** Whether an input cell selects the task: an empty cell selects every task, and a FEEL or comparison cell cannot be decided here. */
const selects = (cell: Cell | undefined, taskId: string): Match => {
  if (cell === undefined) {
    return "yes";
  }
  if ("in" in cell) {
    return cell.in.includes(taskId) ? "yes" : "no";
  }
  if ("notIn" in cell) {
    return cell.notIn.includes(taskId) ? "no" : "yes";
  }
  return "maybe";
};

/**
 * Every row of every kind that is about one task: its creation rules, configuration, permissions, completion, and the
 * task-type entry. Cancellation rows are included when they name a process category the task is created with.
 */
export function taskRows(spec: Spec, taskId: string): TaskRows[] {
  const found: TaskRows[] = [];
  const categories: Categories = { sure: new Set(), possible: new Set() };
  const initiation = spec.decisions.initiation;
  for (const row of initiation?.rows ?? []) {
    const match = mentions(row.returns?.taskId, taskId);
    if (match !== "no") {
      const value = row.returns?.processCategories;
      const into = match === "yes" && typeof value === "string" ? categories.sure : categories.possible;
      for (const category of categoriesOf(value)) {
        into.add(category);
      }
    }
  }
  for (const [kind, decision] of Object.entries(spec.decisions) as Array<[Kind, NonNullable<Spec["decisions"][Kind]>]>) {
    const where = TASK_COLUMN[kind];
    const rows = decision.rows
      .map((row, index) => ({ row, index: index + 1 }))
      .flatMap(({ row, index }) => {
        if (where.side === "when") {
          const match = selects(row.when?.[where.name], taskId);
          return match === "no" ? [] : [{ index, row, ...(match === "maybe" ? { mayApply: true as const } : {}) }];
        }
        const value = row.returns?.[where.name];
        const match = kind === "cancellation" ? cancels(value, categories) : mentions(value, taskId);
        return match === "no" ? [] : [{ index, row, ...(match === "maybe" ? { mayApply: true as const } : {}) }];
      });
    if (rows.length > 0) {
      found.push({ kind, rows });
    }
  }
  return found;
}

export function renderTaskRows(found: TaskRows[]): string {
  return toYaml(
    Object.fromEntries(
      found.map(({ kind, rows }) => [kind, rows.map(({ index, row, mayApply }) => ({ row: index, ...(mayApply ? { mayApply } : {}), ...row }))])
    )
  );
}
