import { byCodePoint } from "../merge.ts";
import type { Cell, Expr, Row, Spec } from "../schema.ts";
import type { Lifecycle, LifecycleEvent } from "./lifecycle.ts";

export interface EventTasks {
  creates: string[];
  completes: string[];
  cancels: string[];
  reconfigures: string[];
}

export interface Overlay {
  events: Record<string, EventTasks>;
  warnings: string[];
}

/** The values an `in` cell lists; any other cell form cannot be read as a list of names. */
const listed = (cell: Cell | undefined): string[] | undefined => (cell && "in" in cell ? cell.in.filter((v): v is string => typeof v === "string") : undefined);

const text = (value: Expr | undefined): string | undefined => (typeof value === "string" ? value : undefined);

const categoriesOf = (value: Expr | undefined): string[] | undefined =>
  text(value)
    ?.split(",")
    .map((c) => c.trim())
    .filter(Boolean);

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
        for (const next of [event.postState, ...(event.otherPostStates ?? [])]) {
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

const postStatesOf = (event: LifecycleEvent): string[] | "*" => (event.postState === "*" ? "*" : [event.postState, ...(event.otherPostStates ?? [])]);

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
  const rowsOf = (kind: keyof Spec["decisions"]): Row[] => {
    const decision = spec.decisions[kind];
    const own = decision && (decision.only === undefined || decision.only.includes(caseType.id));
    return own ? decision.rows.filter((row) => row.only === undefined || row.only.includes(caseType.id)) : [];
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
  const startStates = new Map<string, string[] | "*">();
  for (const row of rowsOf("initiation")) {
    const taskId = text(row.returns?.taskId);
    if (!taskId) {
      continue;
    }
    for (const category of categoriesOf(row.returns?.processCategories) ?? []) {
      categories.set(category, [...(categories.get(category) ?? []).filter((t) => t !== taskId), taskId]);
    }
    const named = statesIn(row.when?.postEventState);
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
    statesIn(row.when?.fromState);
    statesIn(row.when?.state);
    const wanted = categoriesOf(row.returns?.processCategories);
    const affected = wanted ? [...new Set(wanted.flatMap((c) => categories.get(c) ?? []))] : taskIds;
    for (const id of ids) {
      const slot = action === "Cancel" ? tasksOf(id).cancels : action === "Reconfigure" ? tasksOf(id).reconfigures : undefined;
      for (const taskId of affected) {
        if (slot) {
          addTo(slot, taskId);
        }
        const event = definedEvents.get(id) as LifecycleEvent;
        const starts = startStates.get(taskId);
        if (action === "Cancel" && starts && starts !== "*" && event.preStates !== "*") {
          const exists = reachable(lifecycle, starts);
          if (!event.preStates.some((s) => exists.has(s))) {
            addTo(
              cancelWarnings,
              `${id} cancels task ${taskId} from ${event.preStates.join(", ")}, but the task exists only in ${[...exists].sort(byCodePoint).join(", ")}`
            );
          }
        }
      }
    }
  }

  for (const [id, tasks] of Object.entries(events)) {
    const roles = (["creates", "completes", "cancels", "reconfigures"] as const).filter((role) => tasks[role].length > 0);
    if (roles.length > 0 && !(definedEvents.get(id) as LifecycleEvent).publish) {
      warnings.push(`${id} ${roles.join(" and ")} tasks but is not Publish: Y, so Work Allocation never sees it`);
    }
  }
  warnings.push(...[...missingEvents].map((e) => `the spec names the event ${e}, which ${lifecycle.caseType} does not define`));
  warnings.push(...[...missingStates].map((s) => `the spec names the state ${s}, which ${lifecycle.caseType} does not define`));
  warnings.push(...cancelWarnings);
  return { events, warnings };
}
