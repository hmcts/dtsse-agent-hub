import { valueSetFor } from "../emits.ts";
import type { Field, FormSpec, Operand, Outcome, Rule, Scalar } from "../schema.ts";
import { allFields, isNegation, isTickedTest } from "../schema.ts";

export interface KeyModel {
  key: string;
  fieldId?: string;
  label: string;
  /** Mandatory outright; conditional keys are not. */
  mandatory: boolean;
  /** Mandatory only when this holds, in the rule engine's terms. */
  requiredWhen?: Record<string, Operand>;
  inputType: Field["inputType"];
  /** Allowed non-empty strings; empty when the key takes free text. */
  allowed: string[];
  blankAllowed: boolean;
  maxLength?: number;
  regex?: string;
  /** Other keys of the same XoR group. */
  groupWith: string[];
}

export const FORMAT_REGEXES = {
  email: "^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$",
  postcode: "^[A-Za-z]{1,2}[0-9Rr][0-9A-Za-z]? ?[0-9][ABD-HJLNP-UW-Zabd-hjlnp-uw-z]{2}$",
  phone: "^(?:\\+44|44|0)[ ]?(?:\\(0\\)[ ]?)?(?:[ -]*\\d){9,10}$",
  numeric: "^[0-9]*$"
} as const;

/** The format a key's name implies when the spec states no regex; generators say so in their output. */
export function inferredFormat(key: string): keyof typeof FORMAT_REGEXES | undefined {
  if (/email$/i.test(key)) {
    return "email";
  }
  if (/postcode$/i.test(key)) {
    return "postcode";
  }
  if (/(phone|phoneno|telephone\w*)$/i.test(key)) {
    return "phone";
  }
  return undefined;
}

/** One model per key the service reads. A key the form does not read has none, and a key on several rows is mandatory if any row says so. */
export function keyModels(spec: FormSpec): KeyModel[] {
  const models = new Map<string, KeyModel>();
  for (const field of allFields(spec)) {
    if (field.role !== "field" || field.mandatory === "not-read") {
      continue;
    }
    const options = field.group?.options.map((o) => o.key) ?? [];
    for (const key of field.keys) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`the key "${key}" is not a word of letters, digits and underscores starting with a letter`);
      }
      const set = valueSetFor(field, key);
      const earlier = models.get(key);
      const model: KeyModel = {
        key,
        fieldId: field.id,
        label: field.label.split("\n")[0]?.trim() ?? "",
        mandatory: field.mandatory === "mandatory" && !(field.group && field.keys.length > 1),
        requiredWhen: field.required?.when,
        inputType: field.inputType,
        allowed: set?.allowed ?? [],
        blankAllowed: set?.blankAllowed ?? true,
        maxLength: field.maxLength,
        regex: field.regex,
        groupWith: options.filter((o) => o !== key)
      };
      models.set(
        key,
        earlier
          ? {
              ...model,
              mandatory: earlier.mandatory || model.mandatory,
              allowed: [...new Set([...earlier.allowed, ...model.allowed])],
              blankAllowed: earlier.blankAllowed && model.blankAllowed,
              groupWith: [...new Set([...earlier.groupWith, ...model.groupWith])]
            }
          : model
      );
    }
  }
  return [...models.values()];
}

export interface MandatoryGroup {
  fieldId?: string;
  /** At least one of these must be non-empty: the sheet marks the whole XoR group mandatory, not each key. */
  keys: string[];
}

export function mandatoryGroups(spec: FormSpec): MandatoryGroup[] {
  return allFields(spec).flatMap((f) =>
    f.role === "field" && f.mandatory === "mandatory" && f.group && f.keys.length > 1 ? [{ fieldId: f.id, keys: f.keys }] : []
  );
}

export type Data = Record<string, string>;

/** The form type as a file-name stem, lower case; a form type that is not letters, digits, underscores and hyphens is refused. */
export function formStem(spec: FormSpec): string {
  const stem = spec.form.formType.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(stem)) {
    throw new Error(`the form type "${spec.form.formType}" cannot be used in a file name: use letters, digits, underscores and hyphens`);
  }
  return stem;
}

/** The option keys of a field's group that are keys of the model, in the group's order. */
export function optionKeys(field: Field, models: Map<string, KeyModel>): string[] {
  return (field.group?.options ?? []).map((o) => o.key).filter((k) => models.has(k));
}

/** Whether the data answers a mandatory group: some box is ticked, or, for a group that is not tick boxes, some key has a value. */
export function groupAnswered(spec: FormSpec, keys: string[], data: Data): boolean {
  const models = modelByKey(spec);
  return keys.some((k) => {
    const model = models.get(k);
    return model?.inputType === "checkbox" ? isTicked(data[k], tickedValues(model)) : (data[k] ?? "") !== "";
  });
}

function same(actual: string | undefined, expected: Scalar): boolean {
  const a = actual ?? "";
  if (expected === null) {
    return a === "";
  }
  if (typeof expected === "boolean") {
    return a.toLowerCase() === String(expected);
  }
  return a.toLowerCase() === expected.toLowerCase();
}

/** The OCR keys and values a sheet id such as "1.2 = jointApplication" stands for, or undefined when the sheet does not say. */
export function resolveRef(spec: FormSpec, id: string, value: Scalar): Record<string, Operand> | undefined {
  const field = allFields(spec).find((f) => f.id === id);
  if (!field) {
    return undefined;
  }
  if (field.keys.length === 1 && field.keys[0]) {
    return { [field.keys[0]]: value };
  }
  const text = value === null ? "" : String(value).toLowerCase();
  const rule = field.rules.find((r) => r.set && Object.values(r.set).some((v) => typeof v === "string" && v.toLowerCase() === text));
  if (rule?.when) {
    return rule.when;
  }
  // An option is named by its label or by the whole words of its key, never by part of a word, and only when exactly one fits.
  const words = (s: string) =>
    s
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[\s_]+/)
      .filter(Boolean);
  const wanted = words(String(value));
  const labelled = field.group?.options.filter((o) => o.label?.toLowerCase() === text) ?? [];
  const named = labelled.length > 0 ? labelled.map((o) => o.key) : field.keys.filter((k) => wanted.length > 0 && wanted.every((w) => words(k).includes(w)));
  const [only] = named;
  return named.length === 1 && only ? { [only]: { ticked: true } } : undefined;
}

type Verdict = boolean | undefined;

const byKeyCache = new WeakMap<FormSpec, Map<string, KeyModel>>();

export function modelByKey(spec: FormSpec): Map<string, KeyModel> {
  let map = byKeyCache.get(spec);
  if (!map) {
    map = new Map(keyModels(spec).map((k) => [k.key, k]));
    byKeyCache.set(spec, map);
  }
  return map;
}

function operandHolds(spec: FormSpec, data: Data, key: string, operand: Operand): boolean {
  if (isTickedTest(operand)) {
    const model = modelByKey(spec).get(key);
    return (model ? isTicked(data[key], tickedValues(model)) : false) === operand.ticked;
  }
  return isNegation(operand) ? !same(data[key], operand.not) : same(data[key], operand);
}

/** Whether every condition holds for the data; undefined when one cannot be decided from the model's keys. */
export function holds(spec: FormSpec, data: Data, when: Record<string, Operand>): Verdict {
  let unknown = false;
  for (const [key, operand] of Object.entries(when)) {
    const negated = isNegation(operand);
    let tests: Record<string, Operand> | undefined = { [key]: operand };
    if (/^\d/.test(key)) {
      tests = isTickedTest(operand) ? undefined : resolveRef(spec, key, negated ? operand.not : operand);
    }
    if (!tests || key.startsWith("ccd:") || Object.keys(tests).some((k) => !modelByKey(spec).has(k))) {
      unknown = true;
      continue;
    }
    const entries = Object.entries(tests);
    if (/^\d/.test(key)) {
      // A sheet id stands for all the keys it resolves to together, so negating it negates their conjunction.
      const all = entries.every(([k, o]) => operandHolds(spec, data, k, o));
      if (negated === all) {
        return false;
      }
    } else if (!entries.every(([k, o]) => operandHolds(spec, data, k, o))) {
      return false;
    }
  }
  return unknown ? undefined : true;
}

export interface RuleVerdict {
  ref?: string;
  outcome?: Outcome;
  set?: Record<string, string | boolean | null>;
}

/** Whether a rule tests anything: an empty `when` or `whenAny` is no condition. */
export function hasCondition(rule: Rule): boolean {
  return (!!rule.when && Object.keys(rule.when).length > 0) || (!!rule.whenAny && rule.whenAny.length > 0);
}

/**
 * How the sheet's branches group: a numbered branch joins the ELSE chain before it, an independent branch or one after an ELSE starts a
 * new chain, and a branch with no condition is a statement of its own that applies whatever else holds. The generated Java and the rule
 * engine both read the rules through this one grouping.
 */
export function partitionRules(rules: Rule[]): { chains: Rule[][]; unconditional: Rule[] } {
  const chains: Rule[][] = [];
  const unconditional: Rule[] = [];
  let open = false;
  for (const rule of rules) {
    if (!hasCondition(rule) && !rule.otherwise) {
      unconditional.push(rule);
      continue;
    }
    if (!open || rule.independent) {
      chains.push([]);
    }
    chains[chains.length - 1]?.push(rule);
    open = !rule.otherwise;
  }
  return { chains, unconditional };
}

function conditionTestable(spec: FormSpec, key: string, operand: Operand): boolean {
  if (key.startsWith("ccd:")) {
    return false;
  }
  if (/^\d/.test(key)) {
    const resolved = isTickedTest(operand) ? undefined : resolveRef(spec, key, isNegation(operand) ? operand.not : operand);
    return !!resolved && Object.keys(resolved).every((k) => modelByKey(spec).has(k));
  }
  return modelByKey(spec).has(key);
}

/**
 * Whether every branch is something the generated Java can test: no English action, and every condition on keys of the model. The
 * engine answers only for such rules, so what the manifest expects is what the generated validator does.
 */
export function rulesCodeable(spec: FormSpec, rules: Rule[]): boolean {
  return rules.every(
    (rule) =>
      rule.action === undefined &&
      (rule.whenAny ?? (rule.when ? [rule.when] : [])).every((group) => Object.entries(group).every(([key, operand]) => conditionTestable(spec, key, operand)))
  );
}

const RANK = ["success", "warning", "exception"] as const;

/**
 * The branches of a field's rules that apply to the data: the first that holds in each chain, then the unconditional rules.
 * Undefined when a branch cannot be decided from the keys.
 */
export function appliedRules(spec: FormSpec, field: Field, data: Data): Rule[] | undefined {
  if (!rulesCodeable(spec, field.rules)) {
    return undefined;
  }
  const { chains, unconditional } = partitionRules(field.rules);
  const applied: Rule[] = [];
  for (const chain of chains) {
    for (const rule of chain) {
      const holdsNow = rule.otherwise ? true : rule.whenAny ? anyOf(spec, data, rule) : rule.when ? holds(spec, data, rule.when) : true;
      if (holdsNow === undefined) {
        return undefined;
      }
      if (holdsNow) {
        applied.push(rule);
        break;
      }
    }
  }
  return [...applied, ...unconditional];
}

/**
 * What a field's rules do for the data: the worst outcome and the sets of the branches that apply. Undefined when nothing applies
 * or a branch cannot be decided from the keys.
 */
export function evaluateRules(spec: FormSpec, field: Field, data: Data): RuleVerdict | undefined {
  const applied = appliedRules(spec, field, data);
  const decided = (applied ?? []).filter((r) => r.outcome || r.set);
  if (decided.length === 0) {
    return undefined;
  }
  const outcomes = decided.flatMap((r) => (r.outcome ? [r.outcome] : []));
  const worst = outcomes.reduce<Outcome | undefined>((w, o) => (w === undefined || RANK.indexOf(o) > RANK.indexOf(w) ? o : w), undefined);
  const set = Object.assign({}, ...decided.map((r) => literalSet(r) ?? {})) as NonNullable<RuleVerdict["set"]>;
  return { ref: decided.find((r) => r.ref)?.ref, outcome: worst, set: Object.keys(set).length > 0 ? set : undefined };
}

function anyOf(spec: FormSpec, data: Data, rule: Rule): Verdict {
  let unknown = false;
  for (const group of rule.whenAny ?? []) {
    const verdict = holds(spec, data, group);
    if (verdict) {
      return true;
    }
    unknown ||= verdict === undefined;
  }
  return unknown ? undefined : false;
}

function literalSet(rule: Rule): RuleVerdict["set"] {
  if (!rule.set) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(rule.set).map(([k, v]) => [k, v !== null && typeof v === "object" ? null : v]));
}

/** CCD fields a single OCR key feeds by plain copy: no condition, no free-text logic, and no other key feeding the same field. */
export function keysByCcd(spec: FormSpec): Map<string, Set<string>> {
  const byCcd = new Map<string, Set<string>>();
  for (const f of allFields(spec)) {
    for (const ccd of f.ccd) {
      byCcd.set(ccd, new Set([...(byCcd.get(ccd) ?? []), ...f.keys]));
    }
  }
  return byCcd;
}

export function directMappings(spec: FormSpec): Map<string, string> {
  const byCcd = keysByCcd(spec);
  const direct = new Map<string, string>();
  for (const f of allFields(spec)) {
    const [key] = f.keys;
    const [ccd] = f.ccd;
    const plain = !f.logicText && !f.logicPreamble && f.todo.length === 0;
    const copiesKey = (r: Rule) => Object.entries(r.set ?? {}).every(([target, v]) => target === ccd && v !== null && typeof v === "object" && v.from === key);
    // "If the key is not null copy it, else raise a warning" is still a straight copy: the warning is validation, not a mapping.
    const unconditional = (r: Rule) => !r.when && !r.whenAny && !r.otherwise;
    const guardedByPresence = (r: Rule) => {
      const test = key === undefined ? undefined : r.when?.[key];
      return !r.whenAny && !r.otherwise && Object.keys(r.when ?? {}).length === 1 && test !== undefined && isNegation(test) && test.not === null;
    };
    const passThrough =
      f.rules.every((r) => !r.action && (!r.set || (copiesKey(r) && (unconditional(r) || guardedByPresence(r))))) &&
      (f.rules.length === 0 || f.rules.some((r) => r.set));
    if (f.role === "field" && f.keys.length === 1 && f.ccd.length === 1 && key && ccd && byCcd.get(ccd)?.size === 1 && passThrough && plain) {
      direct.set(ccd, key);
    }
  }
  return direct;
}

/** Whether a listed value says an option is not chosen. */
export const isOffValue = (value: string): boolean => /^(false|no)$/i.test(value);

/** The strings that mean an option is ticked: the option's own listed values except the off ones, or "true" when none is listed. */
export function tickedValues(model: KeyModel): string[] {
  const on = model.allowed.filter((v) => !isOffValue(v));
  return on.length > 0 ? on : ["true"];
}

/** A tick box the sheet words as a Yes/No question: both answers are listed, so "No" is an answer and only a blank is unanswered. */
export function isQuestion(model: KeyModel): boolean {
  return model.inputType === "checkbox" && model.allowed.some((v) => /^yes$/i.test(v)) && model.allowed.some((v) => /^no$/i.test(v));
}

/** Whether a mandatory tick box has no answer: blank for a question, else not ticked (an unticked box still sends its "false"). */
export function unanswered(model: KeyModel, value: string | undefined): boolean {
  return model.inputType === "checkbox" && !isQuestion(model) ? !isTicked(value, tickedValues(model)) : (value ?? "") === "";
}

export interface ExclusiveGroup {
  fieldId?: string;
  options: { key: string; ticked: string[] }[];
}

/** XoR groups of tick boxes, where at most one option may be ticked. */
export function exclusiveGroups(spec: FormSpec): ExclusiveGroup[] {
  const models = modelByKey(spec);
  return allFields(spec).flatMap((f) =>
    f.role === "field" && f.inputType === "checkbox" && f.group && f.group.options.length > 1
      ? [
          {
            fieldId: f.id,
            options: f.group.options.flatMap((o) => (models.has(o.key) ? [{ key: o.key, ticked: tickedValues(models.get(o.key) as KeyModel) }] : []))
          }
        ]
      : []
  );
}

export function isTicked(value: string | undefined, ticked: string[]): boolean {
  return ticked.some((t) => t.toLowerCase() === (value ?? "").toLowerCase());
}

export const DATE_PARTS = { day: "^(0?[1-9]|[12][0-9]|3[01])$", month: "^(0?[1-9]|1[0-2])$", year: "^[0-9]{4}$" } as const;

/** The pattern a key's value must match, which every generator emits: the spec's regex, a date part, or a format its name implies. */
export function formatPattern(model: KeyModel): string | undefined {
  if (model.regex) {
    return model.regex;
  }
  // A tick box or a key with a listed value set is checked against that set, not against a format its name suggests.
  if (model.inputType === "checkbox" || model.allowed.length > 0) {
    return undefined;
  }
  const part = /(day|month|year)$/i.exec(model.key)?.[1]?.toLowerCase() as keyof typeof DATE_PARTS | undefined;
  if (part) {
    return DATE_PARTS[part];
  }
  const format = inferredFormat(model.key);
  return format ? FORMAT_REGEXES[format] : undefined;
}

/**
 * The pattern as every generator emits it: it must match the whole value, so the sheet's own anchors are replaced by one pair around
 * the body. Java's matches(), JSON Schema's pattern and fis's regexes then agree with violatesFormat.
 */
export function anchoredPattern(pattern: string): string {
  const body = pattern.replace(/^\^/, "").replace(/(?<!\\)\$$/, "");
  return `^(?:${body})$`;
}

/** Whether a non-empty value fails its key's format. */
export function violatesFormat(model: KeyModel, value: string | undefined): boolean {
  const pattern = formatPattern(model);
  return !!pattern && !!value && !new RegExp(anchoredPattern(pattern)).test(value);
}

/** Whether a value is longer than the key's maximum length, which the validators and the SSCS schema all enforce. */
export function violatesLength(model: KeyModel, value: string | undefined): boolean {
  return !!model.maxLength && !!value && value.length > model.maxLength;
}

/** A string matching a regular expression, built for the constructs form patterns use; undefined if it cannot be built or does not match. */
export function sampleFromRegex(pattern: string): string | undefined {
  let i = 0;
  const peek = () => pattern[i];
  const classChars = (body: string, negated: boolean): string => {
    const matcher = new RegExp(`[${negated ? "^" : ""}${body}]`);
    const candidates = negated ? "a1x- " : body.replace(/\\d/g, "1").replace(/\\w/g, "a").replace(/\\s/g, " ").replace(/\\(.)/g, "$1");
    return [...candidates].find((c) => matcher.test(c)) ?? "a";
  };
  const atom = (): string => {
    const c = pattern[i++];
    if (c === "(") {
      if (pattern.startsWith("?:", i)) {
        i += 2;
      }
      const inner = alternation();
      i++;
      return inner;
    }
    if (c === "[") {
      const negated = peek() === "^";
      if (negated) {
        i++;
      }
      let end = i;
      while (end < pattern.length && (pattern[end] !== "]" || end === i)) {
        end += pattern[end] === "\\" ? 2 : 1;
      }
      const body = pattern.slice(i, end);
      i = end + 1;
      return classChars(body, negated);
    }
    if (c === "\\") {
      const e = pattern[i++] ?? "";
      return { d: "1", w: "a", s: " ", D: "a", W: "-", S: "a" }[e] ?? e;
    }
    return c === "." ? "a" : (c ?? "");
  };
  const quantity = (): number => {
    const q = peek();
    if (q === "+" || q === "*" || q === "?") {
      i++;
      return 1;
    }
    // As in JavaScript, a brace that does not open a well-formed {n}, {n,} or {n,m} is an ordinary character.
    const bounds = q === "{" ? /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(i)) : null;
    if (bounds) {
      i += bounds[0].length;
      const n = Number(bounds[1]);
      return n === 0 && Number(bounds[2] || 0) > 0 ? 1 : n;
    }
    return 1;
  };
  const sequence = (): string => {
    let out = "";
    while (i < pattern.length && peek() !== "|" && peek() !== ")") {
      if (peek() === "^" || peek() === "$") {
        i++;
        continue;
      }
      const piece = atom();
      out += piece.repeat(quantity());
    }
    return out;
  };
  const alternation = (): string => {
    const first = sequence();
    while (peek() === "|") {
      i++;
      sequence();
    }
    return first;
  };
  try {
    const sample = alternation();
    return new RegExp(anchoredPattern(pattern)).test(sample) ? sample : undefined;
  } catch {
    return undefined;
  }
}
