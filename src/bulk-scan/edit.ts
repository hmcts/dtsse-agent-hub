import type { Assignment, CcdMatch, Emit, Field, FormSpec, Operand, Rule, Scalar, Section } from "@hmcts-cft/bulk-scan-spec";
import { proposedTypeOf } from "@hmcts-cft/bulk-scan-spec/ccd-match";
import { emitsOf, valueSets } from "@hmcts-cft/bulk-scan-spec/emits";
import { renderCasePath, renderLogic } from "@hmcts-cft/bulk-scan-spec/logic";
import { readsKeys } from "@hmcts-cft/bulk-scan-spec/model";
import { isNegation, isTickedTest } from "@hmcts-cft/bulk-scan-spec/schema";
import { labelLine } from "./outline.ts";

/**
 * The editor's changes to a spec, as pure functions on it. Only the schema, rule wording and allowed-value modules come
 * from the spec package as code: this runs in the browser, which must not load the engine or the importers.
 */

/** The form-level values the editor changes. */
export type HeaderPatch = Partial<Pick<FormSpec["form"], "name" | "formType" | "poBox" | "ccdCaseTypeId">>;

export function patchHeader(spec: FormSpec, patch: HeaderPatch): FormSpec {
  const form = { ...spec.form };
  for (const [name, value] of Object.entries(patch) as [keyof HeaderPatch, string][]) {
    if (value === "" && name !== "name" && name !== "formType") {
      delete form[name];
    } else {
      form[name] = value;
    }
  }
  return { ...spec, form };
}

/** The field values the editor changes in a row. */
export type FieldPatch = Partial<Pick<Field, "id" | "label" | "keys" | "ccd" | "inputType" | "mandatory" | "regex" | "maxLength" | "minLength">>;

/** The ids the form knows the case type has: all its fields when one is picked, else those of rows matched to an existing field. */
function existingIds(spec: FormSpec): Set<string> {
  return new Set(spec.form.ccdFieldIds ?? spec.sections.flatMap((s) => s.fields.flatMap((f) => (f.ccdMatch?.status === "existing" ? f.ccd : []))));
}

/**
 * A field whose CCD ids were typed. An id is an existing field if the picked case type lists it. With no case type
 * picked the form cannot tell, so it is one only if the row listed it as a candidate or another row already matches it. Any
 * other is a field to add, with the id typed as its proposal.
 */
function withTypedCcd(field: Field, known: Set<string>, caseTypePicked: boolean): Field {
  // A row with no status (a sheet's unmapped row, one the matcher skipped) is checked only when a case type can say.
  const match: CcdMatch | undefined = field.ccdMatch ?? (caseTypePicked ? { status: "new" } : undefined);
  if (!match) {
    return field;
  }
  const [id] = field.ccd;
  if (id === undefined) {
    const { ccdMatch: _match, ...rest } = field;
    return rest;
  }
  const [lacking, ...more] = field.ccd.filter((typed) => !known.has(typed) && !(match.candidates ?? []).some((c) => c.id === typed));
  if (lacking === undefined) {
    return { ...field, ccdMatch: { status: "existing", chosenBy: "person", ...(match.group ? { group: match.group } : {}) } };
  }
  return {
    ...field,
    ccdMatch: {
      status: "new",
      newField: { id: lacking, type: match.newField?.type ?? proposedTypeOf(field) },
      ...(more.length > 0 ? { extraNewFields: more.map((id) => ({ id, type: proposedTypeOf(field) })) } : {}),
      chosenBy: "person",
      ...(match.group ? { group: match.group } : {})
    }
  };
}

/** The spec with one field replaced by what `change` makes of it. */
export function mapField(spec: FormSpec, sectionIndex: number, fieldIndex: number, change: (field: Field) => Field): FormSpec {
  return {
    ...spec,
    sections: spec.sections.map((section, s) =>
      s !== sectionIndex ? section : { ...section, fields: section.fields.map((field, f) => (f === fieldIndex ? change(field) : field)) }
    )
  };
}

/** The keys a new list has in place of the old: those at the same position when the list is as long as it was, else none. */
function renamesBetween(before: readonly string[], after: readonly string[]): [string, string][] {
  return before.length !== after.length
    ? []
    : before.flatMap((key, i): [string, string][] => (after[i] !== undefined && after[i] !== key ? [[key, after[i] as string]] : []));
}

function renameIn(when: Record<string, Operand>, from: string, to: string): Record<string, Operand> {
  return Object.fromEntries(Object.entries(when).map(([key, operand]) => [key === from ? to : key, operand]));
}

/** A field's conditions, copies and mandatory condition, with a key renamed. */
function renameRefs(field: Field, from: string, to: string): Field {
  const rules = field.rules.map((rule) => {
    const next: Rule = { ...rule };
    if (rule.when) {
      next.when = renameIn(rule.when, from, to);
    }
    if (rule.whenAny) {
      next.whenAny = rule.whenAny.map((group) => renameIn(group, from, to));
    }
    if (rule.set) {
      next.set = Object.fromEntries(
        Object.entries(rule.set).map(([target, v]) => [target, v !== null && typeof v === "object" && v.from === from ? { from: to } : v])
      );
    }
    return next;
  });
  const required = field.required?.when ? { ...field.required, when: renameIn(field.required.when, from, to) } : field.required;
  return { ...field, rules, ...(required ? { required } : {}) };
}

/** A field's own record of a key it carries: its allowed values and its group's options. */
function renameOwn(field: Field, from: string, to: string): Field {
  const next: Field = { ...renameRefs(field, from, to) };
  if (field.emits) {
    next.emits = field.emits.map((e) => (e.key === from ? { ...e, key: to } : e));
  }
  if (field.group) {
    next.group = { ...field.group, options: field.group.options.map((o) => (o.key === from ? { ...o, key: to } : o)) };
  }
  return next;
}

/**
 * The field without its key at `index`: the key's allowed values, its group option, and every condition and copy of the
 * field that names it go too. Another field's condition on it is left for the engine to refuse, as it does a key no field has.
 */
export function withoutKey(field: Field, index: number): Field {
  const key = field.keys[index];
  const keys = field.keys.filter((_, i) => i !== index);
  const next: Field = { ...field, keys };
  if (key === undefined || key === "" || keys.includes(key)) {
    return regroup(next);
  }
  if (field.emits) {
    const emits = field.emits.filter((e) => e.key !== key);
    if (emits.length > 0) {
      next.emits = emits;
    } else {
      delete next.emits;
    }
  }
  const without = (when: Record<string, Operand>) => Object.fromEntries(Object.entries(when).filter(([k]) => k !== key));
  next.rules = field.rules.map((rule) => {
    const { when, whenAny, set, ...rest } = rule;
    const groups = whenAny?.map(without).filter((g) => Object.keys(g).length > 0);
    const kept = when ? without(when) : undefined;
    const copies = set ? Object.entries(set).filter(([, v]) => !(v !== null && typeof v === "object" && v.from === key)) : undefined;
    return {
      ...rest,
      ...(kept && Object.keys(kept).length > 0 ? { when: kept } : {}),
      ...(groups && groups.length > 0 ? { whenAny: groups } : {}),
      ...(copies && copies.length > 0 ? { set: Object.fromEntries(copies) } : {})
    };
  });
  if (field.required?.when) {
    const { when: _when, ...label } = field.required;
    const kept = without(field.required.when);
    next.required = Object.keys(kept).length > 0 ? { ...label, when: kept } : label;
  }
  return regroup(next);
}

/** An option of a group exists only for a key the field has, so a group follows its field's keys; fewer than two keys is no group. */
function regroup(field: Field): Field {
  if (!field.group) {
    return field;
  }
  const keys = field.keys.filter((key) => key !== "");
  if (keys.length < 2) {
    const { group: _group, ...rest } = field;
    return rest;
  }
  const options = keys.map((key) => field.group?.options.find((o) => o.key === key) ?? { key });
  return { ...field, group: { ...field.group, size: options.length, options } };
}

/**
 * The spec with one field's row values changed. An empty id, regex, minimum or maximum length is the field without one. When the
 * keys change, a key that is spelt differently at the same place is the same key renamed, so its allowed values, group
 * option and every condition and copy that names it follow it; the group then follows the keys. A field that stops being
 * conditional loses its condition.
 */
export function patchField(spec: FormSpec, sectionIndex: number, fieldIndex: number, patch: FieldPatch): FormSpec {
  const before = spec.sections[sectionIndex]?.fields[fieldIndex];
  const renames = patch.keys && before ? renamesBetween(before.keys, patch.keys) : [];
  const changed = mapField(spec, sectionIndex, fieldIndex, (field) => {
    let next: Field = { ...field, ...patch };
    for (const optional of ["id", "regex", "maxLength", "minLength"] as const) {
      if (next[optional] === "" || next[optional] === undefined) {
        delete next[optional];
      }
    }
    if (patch.keys) {
      for (const [from, to] of renames) {
        next = renameOwn(next, from, to);
      }
      next = regroup(next);
    }
    if (patch.mandatory !== undefined && patch.mandatory !== "conditional") {
      delete next.required;
    }
    if (patch.ccd !== undefined) {
      next = withTypedCcd(next, existingIds(spec), spec.form.ccdFieldIds !== undefined);
    }
    return next;
  });
  let result = changed;
  for (const [from, to] of renames) {
    // A key another row still has keeps the conditions that name it.
    if (result.sections.some((section) => section.fields.some((field) => field.keys.includes(from)))) {
      continue;
    }
    result = {
      ...result,
      sections: result.sections.map((section, s) => ({
        ...section,
        fields: section.fields.map((field, f) => (s === sectionIndex && f === fieldIndex ? field : renameRefs(field, from, to)))
      }))
    };
  }
  return result;
}

/** A section's own values. */
export function patchSection(spec: FormSpec, sectionIndex: number, patch: Partial<Pick<Section, "id" | "title">>): FormSpec {
  return { ...spec, sections: spec.sections.map((section, s) => (s === sectionIndex ? { ...section, ...patch } : section)) };
}

function moved<T>(items: readonly T[], from: number, by: -1 | 1): T[] {
  const to = from + by;
  const item = items[from];
  if (item === undefined || to < 0 || to >= items.length) {
    return [...items];
  }
  const rest = items.filter((_, i) => i !== from);
  return [...rest.slice(0, to), item, ...rest.slice(to)];
}

/** A new field is a mandatory text field with an empty key, which `checkSpec` refuses until it has one. */
export function blankField(): Field {
  return { role: "field", label: "", inputType: "text", mandatory: "mandatory", keys: [""], ccd: [], rules: [], todo: [] };
}

export function addField(spec: FormSpec, sectionIndex: number): FormSpec {
  return { ...spec, sections: spec.sections.map((section, s) => (s === sectionIndex ? { ...section, fields: [...section.fields, blankField()] } : section)) };
}

export function removeField(spec: FormSpec, sectionIndex: number, fieldIndex: number): FormSpec {
  return {
    ...spec,
    sections: spec.sections.map((section, s) => (s === sectionIndex ? { ...section, fields: section.fields.filter((_, f) => f !== fieldIndex) } : section))
  };
}

export function moveField(spec: FormSpec, sectionIndex: number, fieldIndex: number, by: -1 | 1): FormSpec {
  return {
    ...spec,
    sections: spec.sections.map((section, s) => (s === sectionIndex ? { ...section, fields: moved(section.fields, fieldIndex, by) } : section))
  };
}

export function addSection(spec: FormSpec): FormSpec {
  const taken = new Set(spec.sections.map((s) => s.id));
  let n = spec.sections.length + 1;
  while (taken.has(String(n))) {
    n += 1;
  }
  return { ...spec, sections: [...spec.sections, { id: String(n), title: "", fields: [] }] };
}

export function removeSection(spec: FormSpec, sectionIndex: number): FormSpec {
  return { ...spec, sections: spec.sections.filter((_, s) => s !== sectionIndex) };
}

export function moveSection(spec: FormSpec, sectionIndex: number, by: -1 | 1): FormSpec {
  return { ...spec, sections: moved(spec.sections, sectionIndex, by) };
}

/** The keys the model reads: those of a field row that is read at all. Rule conditions and copies may name only these. */
export function formKeys(spec: FormSpec): string[] {
  const keys = spec.sections.flatMap((s) => s.fields.filter(readsKeys).flatMap((f) => f.keys.filter((k) => k !== "")));
  return [...new Set(keys)];
}

/** The sheet ids a condition may name instead of a key, with the row's label. */
export function sheetIds(spec: FormSpec): { id: string; label: string }[] {
  return spec.sections.flatMap((s) => s.fields.flatMap((f) => (f.id ? [{ id: f.id, label: labelLine(f) }] : [])));
}

/** Every CCD field id a row of the form names. */
export function ccdIds(spec: FormSpec): string[] {
  return [...new Set(spec.sections.flatMap((s) => s.fields.flatMap((f) => f.ccd)))];
}

/** Removes the TODO or the review marker at `index` of a field once a person has dealt with it. */
export function clearTodo(spec: FormSpec, sectionIndex: number, fieldIndex: number, index: number): FormSpec {
  return mapField(spec, sectionIndex, fieldIndex, (field) => ({ ...field, todo: field.todo.filter((_, i) => i !== index) }));
}

export function clearReview(spec: FormSpec, sectionIndex: number, fieldIndex: number, index: number): FormSpec {
  return mapField(spec, sectionIndex, fieldIndex, (field) => {
    const { review, ...rest } = field;
    const left = (review ?? []).filter((_, i) => i !== index);
    return left.length > 0 ? { ...rest, review: left } : rest;
  });
}

/** Drops the English a field's logic was kept as, once its rules say it. */
export function clearLogicText(field: Field): Field {
  const { logicText: _text, ...rest } = field;
  return rest;
}

/** Starts the rule list of a field whose logic is still English; the English stays beside it until it is cleared. */
export function writeAsRules(field: Field): Field {
  return field.rules.length > 0 ? field : { ...field, rules: [{}] };
}

/** The exact strings Exela sends for one key, and whether blank is a value it may send. */
export function withAllowed(field: Field, key: string, values: readonly string[], blankAllowed: boolean): Field {
  const before = emitsOf(field);
  const old = before.filter((e) => e.key === key);
  const made: Emit[] = [
    ...values.map((value) => {
      const when = old.find((e) => e.value === value)?.when;
      return { ...(when ? { when } : {}), key, value };
    }),
    ...(blankAllowed ? [{ ...(old.find((e) => e.value === "")?.when ? { when: old.find((e) => e.value === "")?.when } : {}), key, value: "" }] : [])
  ];
  const first = before.findIndex((e) => e.key === key);
  const rest = before.filter((e) => e.key !== key);
  const at = first < 0 ? rest.length : before.slice(0, first).filter((e) => e.key !== key).length;
  return { ...field, emits: [...rest.slice(0, at), ...made, ...rest.slice(at)] };
}

/** Whether the field's keys are one mutually exclusive group; turning it on needs two keys. */
export function withGroup(field: Field, grouped: boolean): Field {
  if (!grouped) {
    const { group: _group, ...rest } = field;
    return rest;
  }
  const keys = field.keys.filter((key) => key !== "");
  return keys.length < 2
    ? field
    : {
        ...field,
        group: { kind: "xor", size: keys.length, options: keys.map((key) => field.group?.options.find((o) => o.key === key) ?? { key }) }
      };
}

/** Whether a value reads like one the schema also has as a true, false or null, which a person may mean as that rather than as text. */
export function looksTyped(text: string): boolean {
  return /^(true|false|null)$/i.test(text);
}

/** What a value is: the text, or, when the row says it is one, the true, false or null it spells. */
export function scalarOf(text: string, typed: boolean): Scalar {
  const lower = text.toLowerCase();
  return typed ? (lower === "null" ? null : lower === "true" ? true : lower === "false" ? false : text) : text;
}

export function textOf(value: Scalar): string {
  return value === null ? "null" : String(value);
}

export const OPERATORS = [
  ["=", "="],
  ["!=", "!="],
  ["blank", "is blank"],
  ["filled", "is not blank"],
  ["ticked", "is ticked"],
  ["unticked", "is not ticked"]
] as const;
export type Operator = (typeof OPERATORS)[number][0];

/** A condition as a row of the editor. */
export interface Condition {
  key: string;
  op: Operator;
  value: string;
  /** The value is a true, false or null of the schema, not the text that spells it. */
  typed?: boolean;
}

const isTyped = (value: Scalar): boolean => value === null || typeof value === "boolean";

export function conditionOf(key: string, operand: Operand): Condition {
  if (isTickedTest(operand)) {
    return { key, op: operand.ticked ? "ticked" : "unticked", value: "" };
  }
  if (isNegation(operand)) {
    return operand.not === null ? { key, op: "filled", value: "" } : { key, op: "!=", value: textOf(operand.not), typed: isTyped(operand.not) };
  }
  return operand === null ? { key, op: "blank", value: "" } : { key, op: "=", value: textOf(operand), typed: isTyped(operand) };
}

export function operandOf(condition: Condition): Operand {
  switch (condition.op) {
    case "=":
      return scalarOf(condition.value, condition.typed === true);
    case "!=":
      return { not: scalarOf(condition.value, condition.typed === true) };
    case "blank":
      return null;
    case "filled":
      return { not: null };
    case "ticked":
      return { ticked: true };
    default:
      return { ticked: false };
  }
}

export function conditionsOf(when: Record<string, Operand> | undefined): Condition[] {
  return Object.entries(when ?? {}).map(([key, operand]) => conditionOf(key, operand));
}

/** The conditions as the schema's record; empty is none, since a branch that tests nothing has no `when`. */
export function whenOf(conditions: readonly Condition[]): Record<string, Operand> | undefined {
  return conditions.length === 0 ? undefined : Object.fromEntries(conditions.map((c) => [c.key, operandOf(c)]));
}

/** The words after "Mandatory if" for a condition, as a sheet would write them. */
export function conditionLabel(condition: Condition): string {
  const words = OPERATORS.find(([op]) => op === condition.op)?.[1] ?? condition.op;
  return condition.op === "=" || condition.op === "!=" ? `${condition.key} ${words} ${condition.value}` : `${condition.key} ${words}`;
}

/** The sheet-style wording of conditions: what `required.label` is when this editor wrote it. */
function wordsOfConditions(conditions: readonly Condition[]): string {
  return conditions.map(conditionLabel).join(" AND ");
}

/**
 * A field mandatory only when all of these hold. The label the sheet or the person wrote is kept; one is generated only
 * when there is none, or when the old one is what this editor generated for the conditions it replaces. With no
 * conditions left the field keeps its label and loses the test.
 */
export function withRequired(field: Field, conditions: readonly Condition[]): Field {
  const old = field.required;
  const generated = old ? wordsOfConditions(conditionsOf(old.when)) : "";
  const label = old && old.label !== "" && old.label !== generated ? old.label : wordsOfConditions(conditions);
  const { required: _required, ...rest } = field;
  if (conditions.length === 0) {
    return label === "" ? rest : { ...rest, required: { label } };
  }
  return { ...rest, required: { label, when: whenOf(conditions) } };
}

/** A branch's condition groups: one conjunction, or the OR alternatives. */
export function groupsOf(rule: Rule): Condition[][] {
  return (rule.whenAny ?? (rule.when ? [rule.when] : [])).map(conditionsOf);
}

/** The branch with these condition groups: none is unconditional, one is `when`, several are `whenAny`. */
export function withGroups(rule: Rule, groups: readonly Condition[][]): Rule {
  const { when: _when, whenAny: _whenAny, ...rest } = rule;
  const present = groups.filter((g) => g.length > 0);
  if (present.length === 0) {
    return rest;
  }
  if (present.length === 1) {
    return { ...rest, when: whenOf(present[0] ?? []) };
  }
  return { ...rest, whenAny: present.map((g) => whenOf(g) ?? {}) };
}

/** An ELSE branch tests nothing. */
export function withElse(rule: Rule, otherwise: boolean): Rule {
  if (!otherwise) {
    const { otherwise: _otherwise, ...rest } = rule;
    return rest;
  }
  const { when: _when, whenAny: _whenAny, ...rest } = rule;
  return { ...rest, otherwise: true };
}

/** A branch's assignment as a row: a CCD field and a literal or a copy of a key. */
export interface AssignmentRow {
  target: string;
  copy: boolean;
  value: string;
  /** A literal that is a true, false or null of the schema, not the text that spells it. */
  typed?: boolean;
}

export function assignmentsOf(rule: Rule): AssignmentRow[] {
  return Object.entries(rule.set ?? {}).map(([target, v]: [string, Assignment]) =>
    v !== null && typeof v === "object" ? { target, copy: true, value: v.from } : { target, copy: false, value: textOf(v), typed: isTyped(v) }
  );
}

export function withAssignments(rule: Rule, rows: readonly AssignmentRow[]): Rule {
  const { set: _set, ...rest } = rule;
  return rows.length === 0
    ? rest
    : { ...rest, set: Object.fromEntries(rows.map((r) => [r.target, r.copy ? { from: r.value } : scalarOf(r.value, r.typed === true)])) };
}

/** The rule at `index` replaced by what `change` makes of it; an unset outcome, note or independent flag is left off. */
export function mapRule(field: Field, index: number, change: (rule: Rule) => Rule): Field {
  return {
    ...field,
    rules: field.rules.map((rule, i) => {
      if (i !== index) {
        return rule;
      }
      const next = change(rule);
      for (const optional of ["outcome", "note", "independent"] as const) {
        if (next[optional] === undefined || next[optional] === "" || next[optional] === false) {
          delete next[optional];
        }
      }
      return next;
    })
  };
}

export function addRule(field: Field): Field {
  return { ...field, rules: [...field.rules, {}] };
}

export function removeRule(field: Field, index: number): Field {
  return { ...field, rules: field.rules.filter((_, i) => i !== index) };
}

export function moveRule(field: Field, index: number, by: -1 | 1): Field {
  return { ...field, rules: moved(field.rules, index, by) };
}

/** A list the editor shows as one line of words: keys and CCD ids are separated by spaces, commas or new lines. */
export function wordsOf(text: string): string[] {
  return text.split(/[\s,]+/).filter((word) => word !== "");
}

/** A minimum or maximum length typed as digits: a whole number, or none for an empty box. */
export function maxLengthOf(digits: string): number | undefined {
  return digits === "" ? undefined : Number(digits);
}

/** The rows a saved spec's issues belong to, by `section.field`, and the ones about the form as a whole. */
export function issuesByField(issues: readonly { path: string; message: string }[]): { fields: Map<string, string[]>; form: string[] } {
  const fields = new Map<string, string[]>();
  const form: string[] = [];
  for (const { path, message } of issues) {
    const match = /^sections\.(\d+)\.fields\.(\d+)(?:\.(.+))?$/.exec(path);
    if (!match) {
      form.push(path === "" ? message : `${path}: ${message}`);
      continue;
    }
    const at = `${match[1]}.${match[2]}`;
    fields.set(at, [...(fields.get(at) ?? []), match[3] ? `${match[3]}: ${message}` : message]);
  }
  return { fields, form };
}

/** A field's rules as the transformation sheet words them; the English the sheet kept when the field has no rules. */
export function logicWords(field: Field): string {
  return (field.rules.length > 0 || field.logicPreamble ? renderLogic(field.rules, field.logicPreamble) : field.logicText) ?? "";
}

/** The case path column the field's rules produce. */
export function casePathWords(field: Field): string {
  return [renderCasePath(field.rules, field.neverExceeds), field.casePathNote].filter(Boolean).join("\n\n");
}

/** A key's allowed values as the editor lists them: the exact strings, and whether blank is one. */
export function allowedFor(field: Field, key: string): { values: string[]; blankAllowed: boolean } {
  const set = valueSets(field).find((s) => s.key === key);
  return { values: set?.allowed ?? [], blankAllowed: set?.blankAllowed ?? true };
}

/** The branch without the English the importer could not turn into conditions, once the branch says it in conditions and assignments. */
export function withoutAction(rule: Rule): Rule {
  const { action: _action, ...rest } = rule;
  return rest;
}
