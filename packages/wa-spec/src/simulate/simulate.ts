import type { DmnDocument } from "../dmn-model.ts";
import { generateDocument } from "../generator.ts";
import { categoryParts } from "../model.ts";
import type { Kind, Spec } from "../schema.ts";
import { evaluateDecision, type OutputRow } from "./dmn-eval.ts";

export type CaseData = Record<string, unknown>;

/** One event on the case. `caseData` is merged into the case data before the DMNs run, as the event's submission would. */
export interface SimEvent {
  event: string;
  /** The state before the event; the state the previous event left the case in when left out. */
  fromState?: string;
  /** The state after the event; the case stays in its current state when left out, as CCD's new state does. */
  postState?: string;
  caseData?: CaseData;
}

export interface SimInput {
  caseType: string;
  caseData?: CaseData;
  events: SimEvent[];
  caseId?: string;
  /** The instant the DMNs see as now, an ISO date and time with an offset; the machine's clock when left out. */
  now?: string;
  /** The date the case event handler passes initiation as `now`, `yyyy-MM-dd`; the date of `now` in London when left out. */
  today?: string;
}

export interface ConfigEntry {
  name: string;
  value: unknown;
  canReconfigure?: boolean;
}

export interface PermissionEntry {
  role: string;
  permissions: string[];
  roleCategory?: string;
  authorisations?: string[];
  assignmentPriority?: number;
  autoAssignable: boolean;
  caseAccessCategory?: string;
}

export interface TaskRef {
  id: string;
  taskType: string;
  name: string;
}

export interface SimTask extends TaskRef {
  state: "open" | "completed" | "cancelled";
  processCategories: string[];
  /** The initiation row that created it: delay, working days and the rest, as the DMN returned them. */
  initiation: OutputRow;
  /** The configuration DMN's rows, with raw date attributes: due dates are computed by task management, not here. */
  configuration: ConfigEntry[];
  /** The configuration by name; where a name repeats the last row wins. */
  attributes: Record<string, unknown>;
  permissions: PermissionEntry[];
  /** Whether a warning message reached it, even one with no code or text; the unique warnings it carries are `warnings`. */
  hasWarnings: boolean;
  warnings: Array<{ code: string; text: string }>;
}

export interface StepResult {
  index: number;
  event: string;
  fromState?: string;
  postState?: string;
  created: SimTask[];
  completed: Array<{ task: TaskRef; completionMode: string }>;
  /** Tasks the completion DMN names with a mode other than Auto: the user completes them. */
  completable: Array<{ task: TaskRef; completionMode: string }>;
  cancelled: Array<{ task: TaskRef; processCategories: string[] }>;
  /** A warning with no code or text flags the tasks without adding one, so `code` and `text` are absent. */
  warned: Array<{ task: TaskRef; code?: string; text?: string }>;
  /** The reconfigurable attributes whose value the configuration DMN now gives differently. */
  reconfigured: Array<{ task: TaskRef; changes: Array<{ name: string; from: unknown; to: unknown }> }>;
}

export interface Timeline {
  caseType: string;
  steps: StepResult[];
  /** Every task created, in its state after the last event. */
  tasks: SimTask[];
}

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** WA splits process categories on commas and trims them. */
const splitList = (value: unknown): string[] => (typeof value === "string" ? categoryParts(value) : []);

/** Task management trims the spaces after commas in the strings a DMN returns. */
const trimLists = (value: unknown): unknown =>
  typeof value === "string" && value.includes(",") && value.includes(" ")
    ? value
        .split(",")
        .map((part) => part.trim())
        .join(",")
    : value;

const PREFIX = "__processCategory__";

const ref = (task: SimTask): TaskRef => ({ id: task.id, taskType: task.taskType, name: task.name });

function configurationOf(rows: OutputRow[]): ConfigEntry[] {
  return rows.map((row) => ({
    name: String(row.name),
    value: trimLists(row.value),
    ...(typeof row.canReconfigure === "boolean" ? { canReconfigure: row.canReconfigure } : {})
  }));
}

/** The permission rows that apply to the case: those with a case access category need one of theirs on the case. */
function permissionsOf(rows: OutputRow[], caseData: CaseData): PermissionEntry[] {
  const onCase = typeof caseData.caseAccessCategory === "string" ? caseData.caseAccessCategory : "";
  return rows
    .filter((row) => {
      const wanted = trimLists(row.caseAccessCategory);
      if (typeof wanted !== "string" || wanted.trim() === "") {
        return true;
      }
      const caseCategories = onCase.split(",");
      return onCase.trim() !== "" && wanted.split(",").some((category) => caseCategories.includes(category));
    })
    .map((row) => {
      const roleCategory = asString(row.roleCategory);
      const authorisations = splitList(row.authorisations);
      const caseAccessCategory = asString(row.caseAccessCategory);
      return {
        role: String(row.name),
        permissions: splitList(row.value),
        ...(roleCategory ? { roleCategory } : {}),
        ...(authorisations.length > 0 ? { authorisations } : {}),
        ...(typeof row.assignmentPriority === "number" ? { assignmentPriority: row.assignmentPriority } : {}),
        autoAssignable: row.autoAssignable === true,
        ...(caseAccessCategory ? { caseAccessCategory } : {})
      };
    });
}

/**
 * Plays events on a case against the DMNs a spec generates for its case type, calling each as WA does: completion by task
 * management, then the case event handler's cancellation, warning, reconfiguration and initiation, in that order.
 */
export function simulate(spec: Spec, input: SimInput): Timeline {
  const documents = new Map<Kind, DmnDocument | undefined>();
  const table = (kind: Kind, variables: Record<string, unknown>): OutputRow[] => {
    if (!documents.has(kind)) {
      documents.set(kind, generateDocument(spec, kind, input.caseType));
    }
    const document = documents.get(kind);
    const main = document?.decisions[0];
    return document && main ? evaluateDecision(document, main.id, variables, input.now) : [];
  };

  const caseId = input.caseId ?? "1234567890123456";
  const today =
    input.today ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(input.now === undefined ? new Date() : new Date(input.now));
  const tasks: SimTask[] = [];
  const attributesOf = new Map<string, Record<string, unknown>>();
  let caseData: CaseData = { ...input.caseData };
  let state: string | undefined;

  const configure = (taskAttributes: Record<string, unknown>) => table("configuration", { caseData, taskAttributes });
  const openTasks = () => tasks.filter((task) => task.state === "open");
  const matching = (categories: string[]) => openTasks().filter((task) => categories.every((category) => task.processCategories.includes(category)));

  const steps = input.events.map((event, index): StepResult => {
    const fromState = event.fromState ?? state;
    const postState = event.postState ?? state;
    state = postState;
    caseData = { ...caseData, ...event.caseData };
    const additionalData = { Data: caseData };
    const step: StepResult = {
      index,
      event: event.event,
      ...(fromState === undefined ? {} : { fromState }),
      ...(postState === undefined ? {} : { postState }),
      created: [],
      completed: [],
      completable: [],
      cancelled: [],
      warned: [],
      reconfigured: []
    };

    for (const row of table("completion", { eventId: event.event })) {
      const mode = asString(row.completionMode);
      for (const task of openTasks().filter((t) => t.taskType === row.taskType)) {
        if (mode === "Auto") {
          task.state = "completed";
          step.completed.push({ task: ref(task), completionMode: mode });
        } else if (mode !== undefined) {
          step.completable.push({ task: ref(task), completionMode: mode });
        }
      }
    }

    const caseEvent = { event: event.event, state: postState ?? null, fromState: fromState ?? null };
    const cancellations = table("cancellation", { ...caseEvent, additionalData });
    for (const row of cancellations.filter((r) => r.action === "Cancel")) {
      const categories = [...splitList(row.taskCategories), ...splitList(row.processCategories)];
      for (const task of matching(categories)) {
        task.state = "cancelled";
        step.cancelled.push({ task: ref(task), processCategories: categories });
      }
    }
    const withoutData = table("cancellation", caseEvent);
    const warn = (tasks: SimTask[], warning?: { code: string; text: string }) => {
      for (const task of tasks) {
        task.hasWarnings = true;
        if (!warning) {
          step.warned.push({ task: ref(task) });
        } else if (!task.warnings.some((w) => w.code === warning.code && w.text === warning.text)) {
          task.warnings.push(warning);
          step.warned.push({ task: ref(task), ...warning });
        }
      }
    };
    const warnRows = withoutData
      .filter((r) => r.action === "Warn")
      .map((row) => ({ row, categories: [...splitList(row.taskCategories), ...splitList(row.processCategories)] }));
    const warningOf = ({ row }: (typeof warnRows)[number]) =>
      typeof row.warningCode === "string" && typeof row.warningText === "string" ? { code: row.warningCode, text: row.warningText } : undefined;
    for (const entry of warnRows.filter((e) => !warningOf(e))) {
      warn(matching(entry.categories));
    }
    const caseWide = new Map(warnRows.filter((e) => warningOf(e) && e.categories.length === 0).map((e) => [JSON.stringify(warningOf(e)), warningOf(e)]));
    for (const warning of caseWide.values()) {
      warn(openTasks(), warning);
    }
    for (const entry of warnRows.filter((e) => warningOf(e) && e.categories.length > 0)) {
      warn(matching(entry.categories), warningOf(entry));
    }
    if (withoutData.some((r) => r.action === "Reconfigure")) {
      for (const task of openTasks()) {
        const before = attributesOf.get(task.id) ?? {};
        const configuration = configurationOf(configure(before));
        const reconfigurable = configuration.filter((entry) => entry.canReconfigure === true);
        const changes = reconfigurable
          .filter((entry) => before[entry.name] !== entry.value)
          .map((entry) => ({ name: entry.name, from: before[entry.name], to: entry.value }));
        for (const entry of reconfigurable) {
          task.attributes[entry.name] = entry.value;
          for (const row of task.configuration.filter((r) => r.name === entry.name)) {
            row.value = entry.value;
          }
        }
        attributesOf.set(task.id, { ...before, ...Object.fromEntries(reconfigurable.map((entry) => [entry.name, entry.value])) });
        step.reconfigured.push({ task: ref(task), changes });
      }
    }

    const lastDirection = caseData.lastModifiedDirection as { dateDue?: string } | undefined;
    const initiation = table("initiation", {
      eventId: event.event,
      postEventState: postState ?? null,
      additionalData,
      now: today,
      directionDueDate: lastDirection?.dateDue ?? null
    });
    for (const row of initiation) {
      const taskType = String(row.taskId);
      const processCategories = splitList(row.processCategories);
      const taskAttributes: Record<string, unknown> = {
        taskType,
        name: row.name,
        caseId,
        jurisdiction: spec.service.jurisdiction,
        caseTypeId: input.caseType,
        taskState: "unconfigured",
        ...Object.fromEntries(processCategories.map((category) => [`${PREFIX}${category}`, true]))
      };
      const configuration = configurationOf(configure(taskAttributes));
      const permissions = permissionsOf(table("permissions", { caseData, taskAttributes }), caseData);
      const task: SimTask = {
        id: `${taskType}-${tasks.length + 1}`,
        taskType,
        name: String(row.name),
        state: "open",
        processCategories,
        initiation: row,
        configuration,
        attributes: Object.fromEntries(configuration.map((entry) => [entry.name, entry.value])),
        permissions,
        hasWarnings: false,
        warnings: []
      };
      attributesOf.set(task.id, { ...taskAttributes, ...task.attributes });
      tasks.push(task);
      step.created.push(structuredClone(task));
    }
    return step;
  });
  return { caseType: input.caseType, steps, tasks };
}
