import { byCodePoint } from "../merge.ts";
import { categoryParts } from "../model.ts";
import { withCanonicalEvent } from "../model-compile.ts";
import type { Cell, Expr, Kind, Row, Spec } from "../schema.ts";
import type { Lifecycle, LifecycleEvent } from "./lifecycle.ts";

export interface EventTasks {
  creates: string[];
  completes: string[];
  cancels: string[];
  reconfigures: string[];
  /** Tasks whose process category the spec computes, which a cancellation row with a computed category may cancel. */
  mayCancel?: string[];
}

export interface Overlay {
  events: Record<string, EventTasks>;
  warnings: string[];
}

/** The values an `in` cell lists; any other cell form cannot be read as a list of names. */
const listed = (cell: Cell | undefined): string[] | undefined => (cell && "in" in cell ? cell.in.filter((v): v is string => typeof v === "string") : undefined);

const text = (value: Expr | undefined): string | undefined => (typeof value === "string" ? value : undefined);

const categoriesOf = (value: Expr | undefined): string[] | undefined => {
  const plain = text(value);
  return plain === undefined ? undefined : categoryParts(plain);
};

/** A category the spec computes: a value that is neither absent, null (no filter) nor a plain string. */
const isComputed = (value: Expr | undefined): boolean => value !== undefined && value !== null && typeof value !== "string";

const addTo = (list: string[], value: string): void => {
  if (!list.includes(value)) {
    list.push(value);
  }
};

/** The states a case reaches from `start` by events whose pre-states allow it, following each event's post-states. */
function reachable(lifecycle: Lifecycle, start: string[]): Set<string> {
  const seen = new Set(start);
  const queue = [...start];
  for (let state = queue.shift(); state !== undefined; state = queue.shift()) {
    for (const event of lifecycle.events) {
      if (event.preStates === "*" || event.preStates.includes(state)) {
        const moves = event.postStateFromCallback ? lifecycle.states.map((s) => s.id) : [event.postState, ...(event.otherPostStates ?? [])];
        for (const next of moves) {
          if (next !== "*" && !seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
    }
  }
  return seen;
}

const postStatesOf = (event: LifecycleEvent): string[] | "*" => {
  const all = [event.postState, ...(event.otherPostStates ?? [])];
  return all.includes("*") ? "*" : all;
};

/**
 * Where each task of a spec's tables meets the lifecycle of one case type: the events that create, complete, cancel and
 * reconfigure it, and what in the spec the definition cannot back. Only the rows that name events as lists are read; a FEEL
 * cell cannot be resolved without case data.
 */
export function overlayTasks(lifecycle: Lifecycle, spec: Spec): Overlay {
  const warnings: string[] = [];
  const events: Record<string, EventTasks> = {};
  const caseType = spec.caseTypes.find((c) => c.id.toLowerCase() === lifecycle.caseType.toLowerCase());
  if (!caseType) {
    return { events, warnings: [`the spec has no case type ${lifecycle.caseType}`] };
  }
  const definedEvents = new Map(lifecycle.events.map((e) => [e.id, e]));
  const definedStates = new Set(lifecycle.states.map((s) => s.id));
  const rowsOf = (kind: Kind): Row[] => {
    const decision = spec.decisions[kind];
    const own = decision && (decision.only === undefined || decision.only.includes(caseType.id));
    return own
      ? decision.rows
          .filter((row) => row.only === undefined || row.only.includes(caseType.id))
          .map((row) => (row.when ? { ...row, when: withCanonicalEvent(kind, row.when) } : row))
      : [];
  };
  const tasksOf = (event: string): EventTasks => (events[event] ??= { creates: [], completes: [], cancels: [], reconfigures: [] });
  const missingEvents = new Set<string>();
  const missingStates = new Set<string>();
  const eventsIn = (cell: Cell | undefined): string[] => {
    const names = listed(cell) ?? [];
    for (const name of names) {
      if (!definedEvents.has(name)) {
        missingEvents.add(name);
      }
    }
    return names.filter((n) => definedEvents.has(n));
  };
  const statesIn = (cell: Cell | undefined): string[] => {
    const names = listed(cell) ?? [];
    for (const name of names) {
      if (!definedStates.has(name)) {
        missingStates.add(name);
      }
    }
    return names.filter((n) => definedStates.has(n));
  };

  const categories = new Map<string, string[]>();
  const computedCategories = new Set<string>();
  const startStates = new Map<string, string[] | "*">();
  for (const row of rowsOf("initiation")) {
    const taskId = text(row.returns?.taskId);
    if (!taskId) {
      continue;
    }
    if (isComputed(row.returns?.processCategories)) {
      computedCategories.add(taskId);
    }
    for (const category of categoriesOf(row.returns?.processCategories) ?? []) {
      categories.set(category, [...(categories.get(category) ?? []).filter((t) => t !== taskId), taskId]);
    }
    const named = statesIn(row.when?.postEventState);
    if (listed(row.when?.eventId) === undefined) {
      startStates.set(taskId, "*");
    }
    for (const id of eventsIn(row.when?.eventId)) {
      addTo(tasksOf(id).creates, taskId);
      const post = postStatesOf(definedEvents.get(id) as LifecycleEvent);
      const here = named.length > 0 ? named : post;
      const before = startStates.get(taskId) ?? [];
      startStates.set(taskId, here === "*" || before === "*" ? "*" : [...new Set([...before, ...here])]);
      if (named.length > 0 && post !== "*" && !named.some((s) => post.includes(s))) {
        warnings.push(`task ${taskId} is created on ${id} in ${named.join(", ")}, which the definition leaves in ${post.join(", ")}`);
      }
    }
  }
  const taskIds = [...startStates.keys()];

  for (const row of rowsOf("completion")) {
    const taskId = text(row.returns?.taskType);
    for (const id of eventsIn(row.when?.eventID)) {
      if (taskId) {
        addTo(tasksOf(id).completes, taskId);
      }
    }
  }

  const cancelWarnings: string[] = [];
  for (const row of rowsOf("cancellation")) {
    const action = text(row.returns?.action);
    const ids = eventsIn(row.when?.event);
    const fromStates = listed(row.when?.fromState);
    statesIn(row.when?.fromState);
    statesIn(row.when?.state);
    statesIn(row.when?.toState);
    if (isComputed(row.returns?.processCategories)) {
      for (const id of action === "Cancel" ? ids : []) {
        const tasks = tasksOf(id);
        const list = tasks.mayCancel ?? [];
        tasks.mayCancel = list;
        for (const taskId of computedCategories) {
          addTo(list, taskId);
        }
      }
      continue;
    }
    const wanted = categoriesOf(row.returns?.processCategories);
    const affected = wanted && wanted.length > 0 ? [...new Set(wanted.flatMap((c) => categories.get(c) ?? []))] : taskIds;
    for (const id of ids) {
      const slot = action === "Cancel" ? tasksOf(id).cancels : action === "Reconfigure" ? tasksOf(id).reconfigures : undefined;
      for (const taskId of affected) {
        if (slot) {
          addTo(slot, taskId);
        }
      }
      const event = definedEvents.get(id) as LifecycleEvent;
      const pre = event.preStates === "*" ? (fromStates ?? "*") : fromStates ? event.preStates.filter((s) => fromStates.includes(s)) : event.preStates;
      const starts = affected.map((taskId) => startStates.get(taskId));
      if (action === "Cancel" && pre !== "*" && pre.length > 0 && starts.length > 0 && starts.every((s) => s !== undefined && s !== "*")) {
        const exists = new Set(starts.flatMap((s) => [...reachable(lifecycle, s as string[])]));
        if (!pre.some((s) => exists.has(s))) {
          const one = affected.length === 1;
          addTo(
            cancelWarnings,
            `${id} cancels ${one ? "task" : "tasks"} ${affected.join(", ")} from ${pre.join(", ")}, but ${one ? "the task exists" : "they exist"} only in ${[...exists].sort(byCodePoint).join(", ")}`
          );
        }
      }
    }
  }

  for (const [id, tasks] of Object.entries(events)) {
    if (tasks.mayCancel?.length === 0) {
      delete tasks.mayCancel;
    }
    if (!tasks.creates.length && !tasks.completes.length && !tasks.cancels.length && !tasks.reconfigures.length && !tasks.mayCancel) {
      delete events[id];
      continue;
    }
    const roles = (["creates", "completes", "cancels", "reconfigures", "mayCancel"] as const).filter((role) => (tasks[role]?.length ?? 0) > 0);
    if (roles.length > 0 && !(definedEvents.get(id) as LifecycleEvent).publish) {
      warnings.push(
        `${id} ${roles.map((r) => (r === "mayCancel" ? "may cancel" : r)).join(" and ")} tasks but is not Publish: Y, so Work Allocation never sees it`
      );
    }
  }
  warnings.push(...[...missingEvents].map((e) => `the spec names the event ${e}, which ${lifecycle.caseType} does not define`));
  warnings.push(...[...missingStates].map((s) => `the spec names the state ${s}, which ${lifecycle.caseType} does not define`));
  warnings.push(...cancelWarnings);
  return { events, warnings };
}
