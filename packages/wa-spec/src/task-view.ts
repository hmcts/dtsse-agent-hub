import type { Cell, Expr, Kind, Row, Spec } from "./schema.ts";
import { toYaml } from "./spec-io.ts";

/** Which column of each kind names the task a row is about. */
const TASK_COLUMN: Record<Kind, { side: "when" | "returns"; name: string }> = {
  initiation: { side: "returns", name: "taskId" },
  configuration: { side: "when", name: "taskType" },
  permissions: { side: "when", name: "taskType" },
  completion: { side: "returns", name: "taskType" },
  cancellation: { side: "returns", name: "processCategories" },
  "task-types": { side: "returns", name: "taskTypeId" }
};

export interface TaskRows {
  kind: Kind;
  /** `mayApply` marks a row whose task cell is FEEL, which may or may not match the task. */
  rows: Array<{ index: number; row: Row; mayApply?: true }>;
}

type Match = "yes" | "maybe" | "no";

/** Whether a cancellation row's process categories include one the task is created with; an empty cell is every category. */
const cancels = (value: Expr | undefined, categories: Set<string>): Match => {
  if (value === undefined) {
    return "yes";
  }
  if (typeof value === "string") {
    return categories.has(value) ? "yes" : "no";
  }
  return typeof value === "object" && value !== null && "feel" in value ? "maybe" : categoriesOf(value).some((c) => categories.has(c)) ? "maybe" : "no";
};

/** Every string in a structured expression, which is where a task id or process category would be written. */
const literalsOf = (value: unknown): string[] =>
  typeof value === "string" ? [value] : typeof value === "object" && value !== null ? Object.values(value).flatMap(literalsOf) : [];

const quoted = (text: string): string[] => [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1] as string);

/** The process categories a value may give: a string, the quoted strings of FEEL, or the strings of a structured expression. */
const categoriesOf = (value: Expr | undefined): string[] =>
  typeof value === "object" && value !== null && "feel" in value ? quoted(value.feel) : literalsOf(value);

/** Whether an output value names the task: a scalar or FEEL text does, and a structured expression with the id somewhere in it may. */
const mentions = (value: Expr | undefined, taskId: string): Match => {
  if (typeof value === "string") {
    return value === taskId ? "yes" : "no";
  }
  if (typeof value === "object" && value !== null && "feel" in value) {
    return value.feel.includes(`"${taskId}"`) ? "yes" : "maybe";
  }
  return literalsOf(value).includes(taskId) ? "maybe" : "no";
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
  const categories = new Set<string>();
  const initiation = spec.decisions.initiation;
  for (const row of initiation?.rows ?? []) {
    if (mentions(row.returns?.taskId, taskId) !== "no") {
      for (const category of categoriesOf(row.returns?.processCategories)) {
        categories.add(category);
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
