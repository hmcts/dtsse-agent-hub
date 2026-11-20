import { byCodePoint } from "../merge.ts";
import { withCanonicalEvent } from "../model-compile.ts";
import type { Cell, Expr, Kind, Row, Spec } from "../schema.ts";
import { type Categories, cancels, categoriesOf } from "../task-view.ts";
import type { Lifecycle, LifecycleEvent } from "./lifecycle.ts";

const ROLES = ["creates", "completes", "cancels", "reconfigures", "mayCancel"] as const;
type Role = (typeof ROLES)[number];

export interface EventTasks {
  creates: string[];
  completes: string[];
  cancels: string[];
  reconfigures: string[];
  /** Tasks whose process category the spec computes, which a cancellation row with a computed category may cancel. */
  mayCancel?: string[];
  /** The tasks of each list that a row gave by describing the event (a state-only row, or a `notIn` list) rather than naming it. */
  derived?: Partial<Record<Role, string[]>>;
}

export interface Overlay {
  events: Record<string, EventTasks>;
  warnings: string[];
}

/** The values an `in` cell lists; any other cell form cannot be read as a list of names. */
const listed = (cell: Cell | undefined): string[] | undefined => (cell && "in" in cell ? cell.in.filter((v): v is string => typeof v === "string") : undefined);

const text = (value: Expr | undefined): string | undefined => (typeof value === "string" ? value : undefined);

/** A value the spec computes: neither absent, null (no filter) nor a plain string. */
const isComputed = (value: Expr | undefined): boolean => value !== undefined && value !== null && typeof value !== "string";

/** What an event lists for a task or category the spec computes, which names no task. */
const COMPUTED_TASK = "computed task";
const COMPUTED_CATEGORY = "computed category";

const addTo = (list: string[], value: string): void => {
  if (!list.includes(value)) {
    list.push(value);
  }
};

const postsOf = (event: LifecycleEvent): string[] => [event.postState, ...(event.otherPostStates ?? [])];

/**
 * The states an event can leave a case in. A `*` leaves it where it was, so in a state the event can start from, unless the event's
 * about-to-submit callback sets the state, which is how a service with a `*` post-state moves the case.
 */
function canLeaveIn(event: LifecycleEvent, states: string[]): boolean {
  const posts = postsOf(event);
  return (
    event.postStateFromCallback === true ||
    (posts.includes("*") && event.aboutToSubmitCallback === true) ||
    posts.some((p) => states.includes(p)) ||
    (posts.includes("*") && (event.preStates === "*" || event.preStates.some((s) => states.includes(s))))
  );
}

const canStartIn = (event: LifecycleEvent, states: string[]): boolean => event.preStates === "*" || event.preStates.some((s) => states.includes(s));

/** The states a case reaches from `start` by events whose pre-states allow it, and the events that can fire on the way. */
function reachable(lifecycle: Lifecycle, start: string[]): { states: Set<string>; fired: LifecycleEvent[] } {
  const seen = new Set(start);
  const fired = new Set<LifecycleEvent>();
  const queue = [...start];
  for (let state = queue.shift(); state !== undefined; state = queue.shift()) {
    for (const event of lifecycle.events) {
      if (event.preStates === "*" || event.preStates.includes(state)) {
        fired.add(event);
        const moves = event.postStateFromCallback ? lifecycle.states.map((s) => s.id) : postsOf(event);
        for (const next of moves) {
          if (next !== "*" && !seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
    }
  }
  return { states: seen, fired: [...fired] };
}

const postStatesOf = (event: LifecycleEvent): string[] | "*" => {
  const all = postsOf(event);
  return all.includes("*") ? "*" : all;
};

/**
 * Where each task of a spec's tables meets the lifecycle of one case type: the events that create, complete, cancel and
 * reconfigure it, and what in the spec the definition cannot back. An event cell that lists events names them; one that
 * excludes events (`notIn`) or is empty covers the definition's events, narrowed by the row's states, and what it gives is
 * marked `derived`. A FEEL cell cannot be resolved without case data and is left out.
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
  const tasksOf = (event: string): EventTasks => {
    const tasks = events[event] ?? { creates: [], completes: [], cancels: [], reconfigures: [] };
    events[event] = tasks;
    return tasks;
  };
  /** Lists a task under an event, keeping a task that some row names directly out of the derived list. */
  const record = (event: string, role: Role, task: string, derived: boolean): void => {
    const tasks = tasksOf(event);
    const list = tasks[role] ?? [];
    tasks[role] = list;
    const marked = tasks.derived?.[role] ?? [];
    if (derived) {
      if (list.includes(task) && !marked.includes(task)) {
        return;
      }
      addTo(list, task);
      tasks.derived = { ...tasks.derived, [role]: marked };
      addTo(marked, task);
    } else {
      addTo(list, task);
      if (tasks.derived?.[role]) {
        tasks.derived[role] = marked.filter((t) => t !== task);
      }
    }
  };
  const missingEvents = new Set<string>();
  const missingStates = new Set<string>();
  const known = (names: string[], defined: (n: string) => boolean, missing: Set<string>): string[] => {
    for (const name of names) {
      if (!defined(name)) {
        missing.add(name);
      }
    }
    return names.filter(defined);
  };
  const statesIn = (cell: Cell | undefined): string[] => known(listed(cell) ?? [], (n) => definedStates.has(n), missingStates);
  const eventsIn = (cell: Cell | undefined): string[] => known(listed(cell) ?? [], (n) => definedEvents.has(n), missingEvents);
  /** The events a cell covers: those it lists, or all but those it excludes, or all when it is empty; none when it cannot be read. */
  const expand = (cell: Cell | undefined): { ids: string[]; derived: boolean } | undefined => {
    if (cell && "in" in cell) {
      return { ids: eventsIn(cell), derived: false };
    }
    if (cell && "notIn" in cell) {
      const excluded = known(
        cell.notIn.filter((v): v is string => typeof v === "string"),
        (n) => definedEvents.has(n),
        missingEvents
      );
      return { ids: lifecycle.events.map((e) => e.id).filter((id) => !excluded.includes(id)), derived: true };
    }
    return cell === undefined ? { ids: lifecycle.events.map((e) => e.id), derived: true } : undefined;
  };
  const event = (id: string): LifecycleEvent => definedEvents.get(id) as LifecycleEvent;

  const knownTasks = new Set<string>();
  for (const [kind, column] of [
    ["initiation", "taskId"],
    ["completion", "taskType"]
  ] as const) {
    for (const row of rowsOf(kind)) {
      const task = text(row.returns?.[column]);
      if (task) {
        knownTasks.add(task);
      }
    }
  }
  /** The task ids a value gives: the one it is, or the known ones it names when it is computed, or the marker when it names none. */
  const tasksNamed = (value: Expr | undefined): { tasks: string[]; computed: boolean } => {
    const plain = text(value);
    if (plain) {
      return { tasks: [plain], computed: false };
    }
    if (!isComputed(value)) {
      return { tasks: [], computed: false };
    }
    const named = [...new Set(categoriesOf(value).filter((t) => knownTasks.has(t)))];
    return { tasks: named.length > 0 ? named : [COMPUTED_TASK], computed: true };
  };

  const taskCategories = new Map<string, Categories>();
  const startStates = new Map<string, string[] | "*">();
  for (const row of rowsOf("initiation")) {
    const { tasks: named, computed } = tasksNamed(row.returns?.taskId);
    const postNamed = statesIn(row.when?.postEventState);
    const eventCell = row.when?.eventId;
    const targets = eventCell === undefined && postNamed.length === 0 ? undefined : expand(eventCell);
    if (targets && postNamed.length > 0 && targets.derived) {
      targets.ids = targets.ids.filter((id) => canLeaveIn(event(id), postNamed));
    }
    for (const taskId of named) {
      if (taskId !== COMPUTED_TASK) {
        const own = taskCategories.get(taskId) ?? { sure: new Set<string>(), possible: new Set<string>() };
        taskCategories.set(taskId, own);
        for (const category of categoriesOf(row.returns?.processCategories)) {
          (typeof row.returns?.processCategories === "string" && !computed ? own.sure : own.possible).add(category);
        }
        if (!targets) {
          startStates.set(taskId, "*");
        }
      }
      for (const id of targets?.ids ?? []) {
        record(id, "creates", taskId, targets?.derived ?? false);
        if (taskId === COMPUTED_TASK) {
          continue;
        }
        const post = postStatesOf(event(id));
        const here = postNamed.length > 0 ? postNamed : post;
        const before = startStates.get(taskId) ?? [];
        startStates.set(taskId, here === "*" || before === "*" ? "*" : [...new Set([...before, ...here])]);
        if (!targets?.derived && postNamed.length > 0 && post !== "*" && !postNamed.some((s) => post.includes(s))) {
          const callback = event(id).aboutToSubmitCallback ? ` unless ${id}'s about-to-submit callback moves the case` : "";
          addTo(warnings, `task ${taskId} is created on ${id} in ${postNamed.join(", ")}, which the definition leaves in ${post.join(", ")}${callback}`);
        }
      }
    }
  }
  const taskIds = [...startStates.keys()];

  for (const row of rowsOf("completion")) {
    const { tasks } = tasksNamed(row.returns?.taskType);
    for (const id of eventsIn(row.when?.eventID)) {
      for (const taskId of tasks) {
        record(id, "completes", taskId, false);
      }
    }
  }

  const cancelWarnings: string[] = [];
  for (const row of rowsOf("cancellation")) {
    const action = text(row.returns?.action);
    const fromStates = listed(row.when?.fromState);
    statesIn(row.when?.fromState);
    const toCells = [row.when?.state, row.when?.toState];
    const expanded = expand(row.when?.event);
    if (!expanded) {
      for (const cell of toCells) {
        statesIn(cell);
      }
      continue;
    }
    let ids = expanded.ids;
    if (fromStates) {
      ids = ids.filter((id) => {
        const starts = canStartIn(event(id), fromStates);
        if (!starts && !expanded.derived && fromStates.every((s) => definedStates.has(s))) {
          const pre = event(id).preStates;
          addTo(
            cancelWarnings,
            `a cancellation row from ${fromStates.join(", ")} can never fire for ${id}, which starts from ${pre === "*" ? "any state" : pre.join(", ") || "no state"}`
          );
        }
        return starts;
      });
    }
    for (const cell of toCells) {
      const states = statesIn(cell);
      if (states.length > 0 && states.length === (listed(cell) ?? []).length) {
        const before = ids;
        ids = ids.filter((id) => canLeaveIn(event(id), states));
        if (ids.length === 0 && (before.length > 0 || expanded.derived)) {
          const callback = before.some((id) => event(id).aboutToSubmitCallback) ? " unless an about-to-submit callback moves the case" : "";
          addTo(
            cancelWarnings,
            `${before.length > 0 && !expanded.derived ? `${before.join(", ")} cannot leave the case in` : "no event can leave the case in"} ${states.join(", ")}, so a cancellation row for it never fires${callback}`
          );
        }
      }
    }
    const value = row.returns?.processCategories;
    const match = (taskId: string) => cancels(value, taskCategories.get(taskId) as Categories);
    const affected = taskIds.filter((taskId) => match(taskId) === "yes");
    const maybe = taskIds.filter((taskId) => match(taskId) === "maybe");
    if (isComputed(value) && affected.length === 0 && maybe.length === 0) {
      maybe.push(COMPUTED_CATEGORY);
    }
    for (const id of ids) {
      if (action === "Cancel") {
        for (const taskId of affected) {
          record(id, "cancels", taskId, expanded.derived);
        }
        for (const taskId of maybe) {
          record(id, "mayCancel", taskId, expanded.derived);
        }
      } else if (action === "Reconfigure") {
        for (const taskId of [...affected, ...maybe]) {
          record(id, "reconfigures", taskId, expanded.derived);
        }
      }
      const preStates = event(id).preStates;
      const pre = preStates === "*" ? (fromStates ?? "*") : fromStates ? preStates.filter((s) => fromStates.includes(s)) : preStates;
      const starts = affected.map((taskId) => startStates.get(taskId));
      if (action === "Cancel" && !expanded.derived && pre !== "*" && pre.length > 0 && starts.length > 0 && starts.every((s) => s !== undefined && s !== "*")) {
        const reached = starts.map((s) => reachable(lifecycle, s as string[]));
        const exists = new Set(reached.flatMap((r) => [...r.states]));
        if (!pre.some((s) => exists.has(s))) {
          const one = affected.length === 1;
          const hedge = reached.some((r) => r.fired.some((e) => e.aboutToSubmitCallback)) ? " unless an about-to-submit callback moves the case" : "";
          addTo(
            cancelWarnings,
            `${id} cancels ${one ? "task" : "tasks"} ${affected.join(", ")} from ${pre.join(", ")}, but ${one ? "the task exists" : "they exist"} only in ${[...exists].sort(byCodePoint).join(", ")}${hedge}`
          );
        }
      }
    }
  }

  for (const [id, tasks] of Object.entries(events)) {
    const direct = ROLES.filter((role) => (tasks[role] ?? []).some((t) => !tasks.derived?.[role]?.includes(t)));
    if (!ROLES.some((role) => (tasks[role]?.length ?? 0) > 0)) {
      delete events[id];
    } else if (direct.length > 0 && !event(id).publish) {
      warnings.push(
        `${id} ${direct.map((r) => (r === "mayCancel" ? "may cancel" : r)).join(" and ")} tasks but is not Publish: Y, so Work Allocation never sees it`
      );
    }
  }
  warnings.push(...[...missingEvents].map((e) => `the spec names the event ${e}, which ${lifecycle.caseType} does not define`));
  warnings.push(...[...missingStates].map((s) => `the spec names the state ${s}, which ${lifecycle.caseType} does not define`));
  warnings.push(...cancelWarnings);
  return { events, warnings };
}
