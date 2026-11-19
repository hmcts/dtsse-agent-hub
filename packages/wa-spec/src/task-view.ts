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
  rows: Array<{ index: number; row: Row }>;
}

const mentions = (value: Cell | Expr | undefined, taskId: string): boolean => {
  if (value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value === taskId;
  }
  if (typeof value === "object" && value !== null) {
    if ("in" in value) {
      return value.in.includes(taskId);
    }
    if ("feel" in value) {
      return value.feel.includes(`"${taskId}"`);
    }
  }
  return false;
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
      .filter(({ row }) => {
        const value = where.side === "when" ? row.when?.[where.name] : row.returns?.[where.name];
        if (kind === "cancellation") {
          return typeof value === "string" && categories.has(value);
        }
        return mentions(value, taskId);
      });
    if (rows.length > 0) {
      found.push({ kind, rows });
    }
  }
  return found;
}

export function renderTaskRows(found: TaskRows[]): string {
  return toYaml(Object.fromEntries(found.map(({ kind, rows }) => [kind, rows.map(({ index, row }) => ({ row: index, ...row }))])));
}
