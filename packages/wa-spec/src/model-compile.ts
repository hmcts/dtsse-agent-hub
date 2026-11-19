import { createHash } from "node:crypto";
import { byCodePoint } from "./merge.ts";
import {
  ADDITIONAL_PREFIX,
  type Cancellation,
  type Completion,
  DUE_ATTRIBUTES,
  decodeCell,
  type Grant,
  isValEntry,
  linkText,
  type Model,
  type Ordering,
  type OrderRow,
  PRIORITY_ATTRIBUTES,
  type Task,
  type Trigger,
  type Val,
  validateModel
} from "./model.ts";
import { type Cell, type Decision, type Expr, KINDS, type Kind, type Row, type Spec, validateSpec } from "./schema.ts";

/** What a row says apart from the tasks it is about and the case types it covers. */
export interface Content {
  when: Record<string, Cell>;
  returns: Record<string, Expr>;
  description?: string;
}

/** One row's worth of one task's content: the unit the ordering file refers to. */
export interface Atom {
  ref: string;
  task: string;
  slot: string;
  cases: string[];
  content: Content;
}

/** The kinds whose rows list several tasks in a `taskType` cell, and that cell's input key. */
export const GROUPED: Partial<Record<Kind, string>> = { configuration: "taskType", permissions: "taskType" };

/** The pseudo-task of rows that apply to every task, and of cancellation rules. */
export const ALL_TASKS = "*";
export const RULES = "!";

export function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => byCodePoint(a, b))) : v
  );
}

export const signature = (content: Content, cases: string[]): string => stable({ content, cases });

type Atoms = Record<Kind, Atom[]>;

const caseOrder = (model: Model): string[] => model.caseTypes.map((c) => c.id);
const inOrder = (model: Model, cases: string[]): string[] => caseOrder(model).filter((c) => cases.includes(c));

/** An entry's case types: those of `base` it names, or all of `base` when it names none. */
const within = (model: Model, only: string[] | undefined, base: string[]): string[] => (only ? inOrder(model, only).filter((c) => base.includes(c)) : base);

export function taskCases(model: Model, task: Task): string[] {
  return task.only ? inOrder(model, task.only) : caseOrder(model);
}

interface Piece<T> {
  entry: T;
  cases: string[];
}

/**
 * Splits an entry into what it says for the case types it covers and what its `overrides` replace for individual
 * case types. A `null` override drops the entry for that case type.
 */
function pieces<T extends object>(model: Model, entry: T, cases: string[], overrides: Record<string, object | null> | undefined): Array<Piece<T>> {
  if (!overrides) {
    return [{ entry, cases }];
  }
  const own = Object.keys(overrides).filter((c) => cases.includes(c));
  const rest = cases.filter((c) => !own.includes(c));
  const result: Array<Piece<T>> = rest.length > 0 ? [{ entry, cases: rest }] : [];
  for (const c of inOrder(model, own)) {
    const patch = overrides[c];
    if (patch !== null && patch !== undefined) {
      result.push({ entry: { ...entry, ...patch }, cases: [c] });
    }
  }
  return result;
}

interface ValPiece {
  value: Expr;
  cases: string[];
  reconfigure: boolean | undefined;
}

function valPieces(model: Model, val: Val, cases: string[]): ValPiece[] {
  const entries = Array.isArray(val) ? val : [val];
  return entries.flatMap((entry) => {
    if (!isValEntry(entry)) {
      return [{ value: entry as Expr, cases, reconfigure: undefined }];
    }
    const own = within(model, entry.only, cases);
    const overrides = entry.overrides && Object.fromEntries(Object.entries(entry.overrides).map(([c, value]) => [c, { value }]));
    return pieces(model, entry, own, overrides).map((piece) => ({
      value: piece.entry.value,
      cases: piece.cases,
      reconfigure: entry.reconfigure
    }));
  });
}

/** A task's configuration attributes in the order they are listed and compiled, by DMN attribute name. */
export function attributesOf(task: Task): Array<[string, Val]> {
  const slots: Array<[string, Val | undefined]> = [
    ["workType", task.workType],
    ["roleCategory", task.roleCategory],
    ["title", task.title],
    ["description", task.link ? linkText(task.link) : task.description],
    ...Object.entries(DUE_ATTRIBUTES).map(([key, name]): [string, Val | undefined] => [name, task.due?.[key as keyof typeof DUE_ATTRIBUTES]]),
    ...Object.entries(PRIORITY_ATTRIBUTES).map(([key, name]): [string, Val | undefined] => [name, task.priority?.[key as keyof typeof PRIORITY_ATTRIBUTES]]),
    ...Object.entries(task.additionalProperties ?? {}).map(([key, val]): [string, Val | undefined] => [`${ADDITIONAL_PREFIX}${key}`, val]),
    ...Object.entries(task.attributes ?? {})
  ];
  return slots.filter((slot): slot is [string, Val] => slot[1] !== undefined);
}

export interface ResolvedGrant {
  role: string;
  grant: Grant;
  cases: string[];
}

/** The grants a task's permissions come to: its profile, less what it removes, with its overrides and additions. */
export function resolveGrants(model: Model, task: Task): ResolvedGrant[] {
  const permissions = task.permissions;
  if (permissions === undefined) {
    return [];
  }
  const specs = typeof permissions === "string" ? [{ profile: permissions }] : [permissions].flat();
  return specs.flatMap((spec) => {
    const grants = new Map<string, Grant>(Object.entries(model.permissionProfiles?.[spec.profile ?? ""] ?? {}));
    for (const role of spec.remove ?? []) {
      grants.delete(role);
    }
    for (const [role, patch] of Object.entries(spec.override ?? {})) {
      const base = grants.get(role);
      if (base) {
        grants.set(role, { ...base, ...patch });
      }
    }
    for (const [role, grant] of Object.entries(spec.add ?? {})) {
      grants.set(role, grant);
    }
    const cases = within(model, spec.only, taskCases(model, task));
    return [...grants].map(([role, grant]) => ({ role, grant, cases }));
  });
}

export const joinPerms = (perms: Grant["perms"]): string => (typeof perms === "string" ? perms : perms.join(", "));

export function grantContent(model: Model, role: string, grant: Grant): Content {
  const category = grant.category ?? model.roles?.[role]?.category;
  const returns: Record<string, Expr> = { name: role, value: joinPerms(grant.perms) };
  if (category !== undefined) {
    returns.roleCategory = category;
  }
  if (grant.authorisations !== undefined) {
    returns.authorisations = grant.authorisations;
  }
  if (grant.priority !== undefined) {
    returns.assignmentPriority = grant.priority;
  }
  if (grant.autoAssign !== undefined) {
    returns.autoAssignable = grant.autoAssign;
  }
  if (grant.caseAccessCategory !== undefined) {
    returns.caseAccessCategory = grant.caseAccessCategory;
  }
  return { when: {}, returns, ...(grant.note === undefined ? {} : { description: grant.note }) };
}

function triggerContent(task: Task, trigger: Trigger): Content {
  const when: Record<string, Cell> = { eventId: decodeCell(trigger.event) };
  if (trigger.postState !== undefined) {
    when.postEventState = decodeCell(trigger.postState);
  }
  for (const [key, cell] of Object.entries(trigger.when ?? {})) {
    when[key] = decodeCell(cell);
  }
  const returns: Record<string, Expr> = { taskId: task.id };
  const name = trigger.initialName ?? task.initialName;
  if (name !== undefined) {
    returns.name = name;
  }
  if (trigger.delay !== undefined) {
    returns.delayDuration = trigger.delay;
  }
  const category = trigger.cancelCategory ?? task.cancelCategory;
  if (category !== undefined) {
    returns.processCategories = category;
  }
  return { when, returns };
}

function completionContent(task: Task, completion: Completion): Content {
  const returns: Record<string, Expr> = { taskType: task.id };
  if (completion.mode !== undefined) {
    returns.completionMode = completion.mode;
  }
  return { when: { eventID: decodeCell(completion.event) }, returns };
}

function cancellationContent(rule: Cancellation, category: Expr | undefined): Content {
  const when: Record<string, Cell> = {};
  if (rule.fromState !== undefined) {
    when.fromState = decodeCell(rule.fromState);
  }
  when.event = decodeCell(rule.events);
  if (rule.state !== undefined) {
    when.state = decodeCell(rule.state);
  }
  const returns: Record<string, Expr> = { action: rule.action };
  if (rule.warning?.code !== undefined) {
    returns.warningCode = rule.warning.code;
  }
  if (rule.warning?.text !== undefined) {
    returns.warningText = rule.warning.text;
  }
  if (category !== undefined) {
    returns.processCategories = category;
  }
  return { when, returns, ...(rule.note === undefined ? {} : { description: rule.note }) };
}

/** Every row's worth of content the model describes, per kind, in the order it compiles when nothing says otherwise. */
export function collectAtoms(model: Model): Atoms {
  const atoms = Object.fromEntries(KINDS.map((kind) => [kind, [] as Atom[]])) as Atoms;
  const add = (kind: Kind, task: string, slot: string, cases: string[], content: Content) => {
    atoms[kind].push({ ref: `${task}/${slot}`, task, slot, cases, content });
  };
  const all = caseOrder(model);

  for (const attribute of model.defaults?.configuration ?? []) {
    const cases = attribute.only ? inOrder(model, attribute.only) : all;
    add("configuration", ALL_TASKS, attribute.name, cases, {
      when: {},
      returns: { name: attribute.name, value: attribute.value, canReconfigure: attribute.reconfigure ?? false }
    });
  }
  for (const [role, grant] of Object.entries(model.defaults?.permissions ?? {})) {
    add("permissions", ALL_TASKS, role, all, grantContent(model, role, grant));
  }

  for (const task of model.tasks) {
    const own = taskCases(model, task);
    for (const piece of task.name === undefined ? [] : valPieces(model, task.name, own)) {
      add("task-types", task.id, "type", piece.cases, { when: {}, returns: { taskTypeId: task.id, taskTypeName: piece.value } });
    }
    for (const trigger of task.create ?? []) {
      for (const piece of pieces(model, trigger, within(model, trigger.only, own), trigger.overrides)) {
        add("initiation", task.id, "create", piece.cases, triggerContent(task, piece.entry));
      }
    }
    for (const completion of task.complete ?? []) {
      for (const piece of pieces(model, completion, within(model, completion.only, own), completion.overrides)) {
        add("completion", task.id, "complete", piece.cases, completionContent(task, piece.entry));
      }
    }
    const reconfigurable = new Set(task.reconfigure ?? []);
    for (const [name, val] of attributesOf(task)) {
      for (const piece of valPieces(model, val, own)) {
        const canReconfigure = piece.reconfigure ?? reconfigurable.has(name);
        add("configuration", task.id, name, piece.cases, { when: {}, returns: { name, value: piece.value, canReconfigure } });
      }
    }
    for (const { role, grant, cases } of resolveGrants(model, task)) {
      add("permissions", task.id, role, cases, grantContent(model, role, grant));
    }
  }

  for (const [index, rule] of (model.cancellations ?? []).entries()) {
    const cases = rule.only ? inOrder(model, rule.only) : all;
    for (const category of rule.categories ?? [undefined]) {
      add("cancellation", RULES, rule.id ?? String(index + 1), cases, cancellationContent(rule, category));
    }
  }
  for (const kind of KINDS) {
    atoms[kind] = withRefs(atoms[kind]);
  }
  return atoms;
}

/**
 * Gives every atom the reference the ordering file names it by. A slot with one atom is `<task>/<slot>`; a slot with
 * several (case type variants, a cancellation rule's categories) adds a hash of the atom's content and case types, so an
 * insertion beside an atom does not re-point the others. Identical atoms are told apart by a count.
 */
function withRefs(atoms: Atom[]): Atom[] {
  const sizes = new Map<string, number>();
  for (const atom of atoms) {
    sizes.set(bucketOf(atom), (sizes.get(bucketOf(atom)) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return atoms.map((atom) => {
    if (sizes.get(bucketOf(atom)) === 1) {
      return atom;
    }
    const base = `${bucketOf(atom)}#${createHash("sha1").update(signature(atom.content, atom.cases)).digest("hex").slice(0, 6)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...atom, ref: n > 1 ? `${base}.${n}` : base };
  });
}

const overlapping = (a: string[], b: string[]): boolean => a.some((x) => b.includes(x));

export const bucketOf = (atom: Atom): string => `${atom.task}/${atom.slot}`;

interface OutRow {
  sig: string;
  tasks: string[];
  content: Content;
  cases: string[];
  grouped: boolean;
  description: string | undefined;
  residue?: Row;
}

function orderedRow(decision: Decision, out: OutRow, all: string[], taskKey: string | undefined): Row {
  if (out.residue) {
    return out.residue;
  }
  const when: Record<string, Cell> = { ...out.content.when };
  if (when.eventID && !decision.inputs.some((c) => c.key === "eventID") && decision.inputs.some((c) => c.key === "eventId")) {
    when.eventId = when.eventID;
    delete when.eventID;
  }
  if (out.grouped && taskKey) {
    when[taskKey] = { in: out.tasks };
  }
  const pick = <T>(values: Record<string, T>, keys: string[]): Record<string, T> => {
    const known = keys.filter((k) => k in values);
    return Object.fromEntries([...known, ...Object.keys(values).filter((k) => !known.includes(k))].map((k) => [k, values[k] as T]));
  };
  const orderedWhen = pick(
    when,
    decision.inputs.map((c) => c.key)
  );
  const orderedReturns = pick(
    out.content.returns,
    decision.outputs.map((c) => c.name)
  );
  const description = out.content.description ?? out.description;
  return {
    ...(description === undefined ? {} : { description }),
    ...(out.cases.length === all.length ? {} : { only: out.cases }),
    ...(Object.keys(orderedWhen).length > 0 ? { when: orderedWhen } : {}),
    ...(Object.keys(orderedReturns).length > 0 ? { returns: orderedReturns } : {})
  };
}

/** The rows of one table: the ordering file's rows first, then whatever it does not mention, then unplaced residue rows. */
function buildRows(kind: Kind, decision: Decision, atoms: Atom[], residue: Row[], order: OrderRow[] | undefined, all: string[]): Row[] {
  const taskKey = GROUPED[kind];
  const byRef = new Map(atoms.map((atom) => [atom.ref, atom]));
  const named = new Set((order ?? []).flatMap((item) => (typeof item === "string" ? item : item.row).split(" ")));
  const claimed = new Set<Atom>();
  // A token whose atom changed (its hash covers content and case types) or that was written before its slot gained atoms
  // stands for an atom of the same `<task>/<slot>` that no token names; the one covering its case types is preferred.
  const atomOf = (token: string, only: string[] | undefined): Atom | undefined => {
    const exact = byRef.get(token);
    if (exact) {
      return exact;
    }
    const bucket = token.replace(/#.*$/, "");
    const spares = atoms.filter((a) => bucketOf(a) === bucket && !named.has(a.ref) && !claimed.has(a));
    const spare = spares.find((a) => !only || overlapping(a.cases, only)) ?? spares[0];
    if (spare) {
      claimed.add(spare);
    }
    return spare;
  };
  const covered = new Map<string, Set<string>>();
  const out: OutRow[] = [];
  const usedResidue = new Set<number>();
  const isGrouped = (atom: Atom) => taskKey !== undefined && atom.task !== ALL_TASKS;
  const outRow = (atom: Atom, cases: string[], description: string | undefined): OutRow => ({
    sig: signature(atom.content, cases),
    tasks: [atom.task],
    content: atom.content,
    cases,
    grouped: isGrouped(atom),
    description
  });

  for (const item of order ?? []) {
    const { row, description } = typeof item === "string" ? { row: item, description: undefined } : item;
    const tokens = row.split(" ").filter(Boolean);
    const only = tokens
      .find((t) => t.startsWith("@"))
      ?.slice(1)
      .split(",");
    const members: Array<{ atom: Atom; cases: string[] }> = [];
    for (const token of tokens) {
      if (token.startsWith("~")) {
        const n = Number(token.slice(1));
        const rowOf = residue[n - 1];
        if (rowOf && !usedResidue.has(n)) {
          usedResidue.add(n);
          out.push({ sig: `~${n}`, tasks: [], content: { when: {}, returns: {} }, cases: [], grouped: false, description: undefined, residue: rowOf });
        }
      } else if (!token.startsWith("@")) {
        const atom = atomOf(token, only);
        const cases = atom && (only ? atom.cases.filter((c) => only.includes(c)) : atom.cases);
        if (atom && cases && cases.length > 0) {
          members.push({ atom, cases });
          const seen = covered.get(atom.ref) ?? new Set<string>();
          for (const c of cases) {
            seen.add(c);
          }
          covered.set(atom.ref, seen);
        }
      }
    }
    const first = new Map<string, OutRow>();
    for (const { atom, cases } of members) {
      const made = outRow(atom, cases, description);
      const shared = made.grouped ? first.get(made.sig) : undefined;
      if (shared) {
        shared.tasks.push(atom.task);
      } else {
        out.push(made);
        first.set(made.sig, made);
      }
    }
  }

  // A task's rows must keep their order, so an atom joins an earlier row only if no earlier row already holds the task.
  const lastRowOf = (task: string): number => out.findLastIndex((o) => o.tasks.includes(task));
  for (const atom of atoms) {
    const seen = covered.get(atom.ref);
    const left = atom.cases.filter((c) => !seen?.has(c));
    if (left.length === 0) {
      continue;
    }
    const made = outRow(atom, left, undefined);
    const floor = lastRowOf(atom.task);
    const at = made.grouped ? out.findLastIndex((o) => o.grouped && o.sig === made.sig) : -1;
    const shared = at >= 0 && at > floor ? out[at] : undefined;
    if (shared) {
      shared.tasks.push(atom.task);
    } else {
      out.push(made);
    }
  }
  residue.forEach((rowOf, index) => {
    if (!usedResidue.has(index + 1)) {
      out.push({ sig: `~${index + 1}`, tasks: [], content: { when: {}, returns: {} }, cases: [], grouped: false, description: undefined, residue: rowOf });
    }
  });
  return out.map((o) => orderedRow(decision, o, all, taskKey));
}

/** The standard Work Allocation columns for a table the model's `tables` does not define. */
export function standardDecision(kind: Kind, model: Model): Decision {
  const label = model.service.displayName ?? model.service.slug;
  const string = (key: string, text?: string) => ({ key, ...(text ? { label: text } : {}), variable: key, typeRef: "string" });
  const out = (name: string, text: string, typeRef = "string") => ({ name, label: text, typeRef });
  switch (kind) {
    case "initiation":
      return {
        name: `${label} Task initiation DMN`,
        hitPolicy: "COLLECT",
        historyTimeToLive: "P30D",
        inputs: [string("eventId", "Event Id"), string("postEventState", "Post event state")],
        outputs: [
          out("taskId", "Task Id"),
          out("name", "Name"),
          out("delayDuration", "Delay Duration", "integer"),
          out("processCategories", "Process Categories Identifiers")
        ],
        rows: []
      };
    case "configuration":
      return {
        name: `${label} Task configuration DMN`,
        hitPolicy: "COLLECT",
        historyTimeToLive: "P30D",
        inputs: [string("caseData", "CCD Case Data"), string("taskType", "Task type")],
        outputs: [out("name", "Name"), out("value", "Value"), out("canReconfigure", "Can Reconfigure?", "boolean")],
        rows: []
      };
    case "permissions":
      return {
        name: `${label} Task permissions DMN`,
        hitPolicy: "RULE ORDER",
        historyTimeToLive: "P30D",
        inputs: [string("taskType", "Task Type"), string("case", "Case Data")],
        outputs: [
          out("caseAccessCategory", "Case Access Category"),
          out("name", "Name"),
          out("value", "Value"),
          out("roleCategory", "RoleCategory"),
          out("authorisations", "Authorisations"),
          out("assignmentPriority", "Assignment Priority", "integer"),
          out("autoAssignable", "Auto Assignable", "boolean")
        ],
        rows: []
      };
    case "completion":
      return {
        name: `${label} Task completion DMN`,
        hitPolicy: "COLLECT",
        historyTimeToLive: "P30D",
        inputs: [string("eventID", "Event ID")],
        outputs: [out("taskType", "Task Type"), out("completionMode", "Completion Mode")],
        rows: []
      };
    case "cancellation":
      return {
        name: `${label} Task cancellation DMN`,
        hitPolicy: "COLLECT",
        historyTimeToLive: "P30D",
        inputs: [string("fromState", "From State"), string("event", "Event"), string("state", "State")],
        outputs: [
          out("action", "Action"),
          out("warningCode", "Warning Code"),
          out("warningText", "Warning Text"),
          out("processCategories", "Process Categories Identifiers")
        ],
        rows: []
      };
    case "task-types":
      return {
        name: `${label} Task Types DMN`,
        hitPolicy: "COLLECT",
        historyTimeToLive: "P30D",
        inputs: [{ key: "input", typeRef: "string" }],
        outputs: [
          { name: "taskTypeId", typeRef: "string" },
          { name: "taskTypeName", typeRef: "string" }
        ],
        rows: []
      };
  }
}

/**
 * The table-centric spec a model describes. `ordering` fixes the rows' order and grouping, which a COLLECT or RULE ORDER
 * table returns in; without it rows follow the model's own order and tasks with identical content share a row.
 */
export function compileModel(model: Model, ordering?: Ordering): Spec {
  const invalid = validateModel(model);
  if (invalid.length > 0) {
    throw new Error(`Invalid model:\n${invalid.map((p) => `  ${p}`).join("\n")}`);
  }
  const atoms = collectAtoms(model);
  const all = caseOrder(model);
  const decisions: Spec["decisions"] = {};
  for (const kind of KINDS) {
    const table = model.tables?.[kind];
    if (!table && atoms[kind].length === 0) {
      continue;
    }
    const decision = table ?? standardDecision(kind, model);
    decisions[kind] = { ...decision, rows: buildRows(kind, decision, atoms[kind], table?.rows ?? [], ordering?.rows[kind], all) };
  }
  const spec: Spec = { version: 1, service: model.service, caseTypes: model.caseTypes, decisions };
  const problems = validateSpec(spec);
  if (problems.length > 0) {
    throw new Error(`The model compiles to an invalid spec:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  }
  return spec;
}
