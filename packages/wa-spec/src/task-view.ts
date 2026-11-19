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

/** Whether an output value names the task. */
const mentions = (value: Expr | undefined, taskId: string): boolean => {
  if (typeof value === "string") {
    return value === taskId;
  }
  return typeof value === "object" && value !== null && "feel" in value && value.feel.includes(`"${taskId}"`);
};

type Match = "yes" | "maybe" | "no";

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
  initiation?.rows.forEach((row) => {
    if (mentions(row.returns?.taskId, taskId) && typeof row.returns?.processCategories === "string") {
      categories.add(row.returns.processCategories);
    }
  });
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
        const hit = kind === "cancellation" ? typeof value === "string" && categories.has(value) : mentions(value, taskId);
        return hit ? [{ index, row }] : [];
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
