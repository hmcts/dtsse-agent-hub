import { valueSets } from "../emits.ts";
import type { Field, FormSpec, Outcome } from "../schema.ts";
import { allFields, OUTCOMES } from "../schema.ts";
import type { Data, KeyModel } from "./model.ts";
import {
  anchoredPattern,
  evaluateRules,
  exclusiveGroups,
  formatPattern,
  groupAnswered,
  holds,
  inferredFormat,
  isOffValue,
  isQuestion,
  isTicked,
  mandatoryGroups,
  modelByKey,
  optionKeys,
  rulesCodeable,
  sampleFromRegex,
  tickedValues,
  unanswered,
  violatesFormat,
  violatesLength
} from "./model.ts";

export type ScenarioKind = "valid" | "missing-mandatory" | "invalid-format" | "xor-branch" | "allowed-value";

export interface Scenario {
  name: string;
  kind: ScenarioKind;
  /** What the scenario exercises, in words. */
  description: string;
  data: Data;
  expected: {
    /** The worst outcome of everything the generated validator checks. */
    validation: Outcome;
    /** What validate-ocr answers: WARNINGS for both warning and exception, since ERRORS would reject the envelope back to the supplier. */
    validateOcr: "SUCCESS" | "WARNINGS";
    /** What the orchestrator ends up with: a case, a case carrying warnings, or (a 422 from the transformation) an exception record. */
    transformation: "case-created" | "case-created-with-warnings" | "exception-record";
    basis: string[];
    /** Fields whose rules carry English the generator cannot code, so the validator does not check them and the outcome says nothing of them. */
    unchecked: string[];
  };
}

const SAMPLES = {
  email: "test.user@example.com",
  postcode: "AB1 2DE",
  phone: "01234567890"
};

/** Shorter stand-ins tried when the usual sample is over a key's maximum length. */
const SHORT_SAMPLES = ["a@b.co", "A1 1AA", "0123456789", "Ab", "x", "1"];

/** The first candidate that satisfies the key's format and maximum length; the first candidate when none does. */
function firstFitting(model: KeyModel, candidates: string[]): string {
  return candidates.find((c) => !violatesFormat(model, c) && !violatesLength(model, c)) ?? (candidates[0] as string);
}

export function sampleValue(model: KeyModel): string {
  if (model.inputType === "checkbox") {
    return firstFitting(model, tickedValues(model));
  }
  if (model.allowed.length > 0) {
    return firstFitting(model, model.allowed);
  }
  const pattern = formatPattern(model);
  const guess = defaultSample(model);
  const usual = pattern && !new RegExp(anchoredPattern(pattern)).test(guess) ? (sampleFromRegex(pattern) ?? guess) : guess;
  const fitted = pattern || !model.maxLength ? usual : usual.slice(0, model.maxLength);
  return firstFitting(model, [fitted, ...(pattern ? [sampleFromRegex(pattern)] : []).filter((s): s is string => s !== undefined), ...SHORT_SAMPLES]);
}

function defaultSample(model: KeyModel): string {
  if (/day$/i.test(model.key)) {
    return "18";
  }
  if (/month$/i.test(model.key)) {
    return "01";
  }
  if (/year$/i.test(model.key)) {
    return "2022";
  }
  const format = inferredFormat(model.key);
  const sample = format === undefined || format === "numeric" ? undefined : SAMPLES[format];
  if (sample) {
    return sample;
  }
  return /name$/i.test(model.key) ? "Testname" : "sample";
}

/** Keys whose sample breaks their own format or maximum length, because no value could be built for them: the generated checks would reject the valid submission. */
export function unsatisfiedSamples(spec: FormSpec): string[] {
  return [...modelByKey(spec).values()]
    .filter((m) => {
      const sample = sampleValue(m);
      return violatesFormat(m, sample) || violatesLength(m, sample);
    })
    .map((m) => m.key);
}

/** What a key is set to when its option is not chosen: the sheet's own off value, else blank. */
function offValue(model: KeyModel | undefined): string {
  return model?.allowed.find((v) => isOffValue(v)) ?? "";
}

function firstPass(spec: FormSpec): Data {
  const models = modelByKey(spec);
  const data: Data = {};
  for (const m of models.values()) {
    data[m.key] = sampleValue(m);
  }
  for (const field of allFields(spec)) {
    for (const o of optionKeys(field, models).slice(1)) {
      data[o] = field.inputType === "checkbox" ? offValue(models.get(o)) : (data[o] ?? "");
    }
  }
  return data;
}

const MAX_COMBINATIONS = 512;

/** What a field's keys may be changed to, one entry per way of answering its group and one per key's listed value; combinations of them are tried together. */
function candidates(field: Field, models: Map<string, KeyModel>): Data[] {
  const options = optionKeys(field, models);
  const axes: Data[][] = [];
  if (options.length > 1 && field.inputType === "checkbox") {
    axes.push(
      options.map((on) =>
        Object.fromEntries(options.map((o) => [o, o === on ? (tickedValues(models.get(o) as KeyModel)[0] as string) : offValue(models.get(o))]))
      )
    );
  }
  for (const set of valueSets(field)) {
    axes.push([...set.allowed, ...(set.blankAllowed ? [""] : [])].map((v) => ({ [set.key]: v })));
  }
  // Every combination of one choice per axis, cut off at a bound, with the single-axis changes first.
  const singles = axes.flat();
  const out: Data[] = [...singles];
  let product: Data[] = [{}];
  for (const axis of axes) {
    product = product.flatMap((p) => axis.map((c) => ({ ...p, ...c }))).slice(0, MAX_COMBINATIONS);
  }
  out.push(...product);
  return out;
}

/** Whether a change blanks a key the sheet requires: a mandatory key, or one whose condition holds in the changed data. */
function blanksRequired(spec: FormSpec, models: Map<string, KeyModel>, data: Data, change: Data): boolean {
  return Object.entries(change).some(([key, value]) => {
    const model = models.get(key);
    return value === "" && !!model && (model.mandatory || (!!model.requiredWhen && holds(spec, data, model.requiredWhen) === true));
  });
}

/**
 * A submission with every readable key filled and each XoR group answered, where the answers are chosen so that the sheet's own
 * rules produce no warning: a field whose first sample value triggers a warning is tried with its other allowed values and options.
 */
export function validData(spec: FormSpec): Data {
  const cached = validDataCache.get(spec);
  if (cached) {
    return { ...cached };
  }
  const data = solveValidData(spec);
  validDataCache.set(spec, data);
  return { ...data };
}

const validDataCache = new WeakMap<FormSpec, Data>();

function solveValidData(spec: FormSpec): Data {
  const data = firstPass(spec);
  const models = modelByKey(spec);
  for (let pass = 0; pass < 3; pass++) {
    for (const field of allFields(spec)) {
      if (field.role !== "field" || !field.rules.some((r) => r.outcome)) {
        continue;
      }
      const outcome = (d: Data) => evaluateRules(spec, field, d)?.outcome;
      const now = outcome(data);
      if (now === undefined || now === "success") {
        continue;
      }
      // A fix must clear the field's own warning without bringing a group, value, format or length warning of its own.
      const problems = (d: Data) => expectedFor(spec, d).basis.filter((b) => !b.endsWith(": success")).length;
      const before = problems(data);
      const fix = candidates(field, models).find((c) => {
        const changed = { ...data, ...c };
        return !blanksRequired(spec, models, changed, c) && outcome(changed) === "success" && problems(changed) < before;
      });
      if (fix) {
        Object.assign(data, fix);
      }
    }
  }
  return data;
}

/** Fields (by id) whose sheet rules still give a warning on the valid sample, because no combination of their values clears it. */
export function unsatisfiedRules(spec: FormSpec): string[] {
  const data = validData(spec);
  return allFields(spec)
    .filter((f) => f.role === "field" && f.rules.some((r) => r.outcome))
    .filter((f) => {
      const outcome = evaluateRules(spec, f, data)?.outcome;
      return outcome !== undefined && outcome !== "success";
    })
    .map((f) => f.id ?? f.keys[0] ?? "?");
}

/** A value that really breaks the key's format pattern, or undefined when the key has no pattern or nothing tried breaks it. */
export function invalidValue(model: KeyModel): string | undefined {
  if (!formatPattern(model)) {
    return undefined;
  }
  return ["99", "13", "20x2", "not-an-email", "12345", "!!invalid!!", "abc", "0", "x".repeat(40)].find((v) => violatesFormat(model, v));
}

export function expectedFor(spec: FormSpec, data: Data): Scenario["expected"] {
  const rank = (o: Outcome) => OUTCOMES.indexOf(o);
  let worst: Outcome = "success";
  const basis: string[] = [];
  const unchecked: string[] = [];
  const note = (o: Outcome, why: string) => {
    basis.push(`${why}: ${o}`);
    if (rank(o) > rank(worst)) {
      worst = o;
    }
  };
  for (const field of allFields(spec)) {
    if (field.role !== "field") {
      continue;
    }
    const id = field.id ?? field.keys[0] ?? "?";
    if (field.rules.some((r) => r.outcome)) {
      const verdict = evaluateRules(spec, field, data);
      if (verdict?.outcome) {
        note(verdict.outcome, `${id} rule ${verdict.ref ?? "(unnumbered)"}`);
      } else if (!rulesCodeable(spec, field.rules)) {
        unchecked.push(id);
      }
    }
  }
  for (const m of modelByKey(spec).values()) {
    const blank = unanswered(m, data[m.key]);
    if (blank && m.mandatory) {
      note("warning", `${m.key} mandatory and empty (sheet: empty gives warning)`);
    } else if (blank && m.requiredWhen && holds(spec, data, m.requiredWhen)) {
      note("warning", `${m.key} mandatory under its condition and empty`);
    }
  }
  for (const g of mandatoryGroups(spec)) {
    if (!groupAnswered(spec, g.keys, data)) {
      note("warning", `group ${g.fieldId ?? g.keys[0]} is mandatory and no option is answered`);
    }
  }
  for (const m of modelByKey(spec).values()) {
    const value = data[m.key] ?? "";
    if (m.allowed.length > 0 && value !== "" && !m.allowed.some((a) => a.toLowerCase() === value.toLowerCase())) {
      note("warning", `${m.key} has a value that is not listed for it`);
    }
    if (violatesFormat(m, data[m.key])) {
      note("warning", `${m.key} does not match its format`);
    }
    if (violatesLength(m, data[m.key])) {
      note("warning", `${m.key} is longer than ${m.maxLength} characters`);
    }
  }
  for (const g of exclusiveGroups(spec)) {
    if (g.options.filter((o) => isTicked(data[o.key], o.ticked)).length > 1) {
      note("warning", `group ${g.fieldId ?? g.options[0]?.key} has more than one option ticked`);
    }
  }
  return {
    validation: worst,
    validateOcr: worst === "success" ? "SUCCESS" : "WARNINGS",
    transformation: worst === "success" ? "case-created" : worst === "warning" ? "case-created-with-warnings" : "exception-record",
    basis,
    unchecked
  };
}

function scenario(spec: FormSpec, kind: ScenarioKind, name: string, description: string, data: Data): Scenario {
  return { name, kind, description, data, expected: expectedFor(spec, data) };
}

/** Sample submissions: one valid, each mandatory key missing, each checkable format broken, each XoR branch, each allowed value. */
export function scenarios(spec: FormSpec): Scenario[] {
  const base = validData(spec);
  const byKey = modelByKey(spec);
  const models = [...byKey.values()];
  const out: Scenario[] = [scenario(spec, "valid", "valid", "every readable key filled, each XoR group answered by its first option", base)];

  for (const m of models.filter((k) => k.mandatory)) {
    out.push(scenario(spec, "missing-mandatory", `missing-${m.key}`, `mandatory key ${m.key} left blank`, { ...base, [m.key]: "" }));
  }
  for (const m of models.filter((k) => k.mandatory && k.inputType === "checkbox" && !isQuestion(k))) {
    out.push(
      scenario(spec, "missing-mandatory", `missing-${m.key}-unticked`, `mandatory tick box ${m.key} sent as its unticked value`, {
        ...base,
        [m.key]: offValue(m)
      })
    );
  }
  for (const g of mandatoryGroups(spec)) {
    out.push(
      scenario(spec, "missing-mandatory", `missing-group-${g.fieldId ?? g.keys[0]}`, `every key of mandatory group ${g.fieldId ?? g.keys[0]} left blank`, {
        ...base,
        ...Object.fromEntries(g.keys.map((k) => [k, ""]))
      })
    );
  }
  for (const m of models) {
    const bad = invalidValue(m);
    if (bad !== undefined) {
      out.push(scenario(spec, "invalid-format", `invalid-${m.key}`, `${m.key} does not match ${formatPattern(m)}`, { ...base, [m.key]: bad }));
    }
  }
  for (const field of allFields(spec)) {
    const options = optionKeys(field, byKey);
    if (options.length < 2 || field.role !== "field") {
      continue;
    }
    const id = field.id ?? options[0] ?? "group";
    const on = (o: string) => (field.inputType === "checkbox" ? (tickedValues(byKey.get(o) as KeyModel)[0] as string) : "x");
    const off = (o: string) => (field.inputType === "checkbox" ? offValue(byKey.get(o)) : "");
    const set = (ticked: string[]) => ({ ...base, ...Object.fromEntries(options.map((o) => [o, ticked.includes(o) ? on(o) : off(o)])) });
    for (const o of options) {
      out.push(scenario(spec, "xor-branch", `xor-${id}-${o}`, `${id}: only ${o} ticked`, set([o])));
    }
    out.push(scenario(spec, "xor-branch", `xor-${id}-none`, `${id}: nothing ticked, each option sent as its unticked value`, set([])));
    if (field.inputType === "checkbox") {
      out.push(
        scenario(spec, "xor-branch", `xor-${id}-none-blank`, `${id}: nothing ticked, every option left blank`, {
          ...base,
          ...Object.fromEntries(options.map((o) => [o, ""]))
        })
      );
    }
    out.push(scenario(spec, "xor-branch", `xor-${id}-all`, `${id}: every option ticked`, set(options)));
  }
  for (const m of models) {
    const values = m.inputType === "checkbox" && m.allowed.length === 0 ? [] : [...m.allowed, ...(m.allowed.length > 0 && m.blankAllowed ? [""] : [])];
    values.forEach((v, i) => {
      if (i === 0 && v === sampleValue(m)) {
        return;
      }
      out.push(
        scenario(spec, "allowed-value", `value-${m.key}-${v === "" ? "blank" : v.replace(/[^A-Za-z0-9]+/g, "_")}`, `${m.key} = ${JSON.stringify(v)}`, {
          ...base,
          [m.key]: v
        })
      );
    });
  }
  return uniqueNames(out);
}

/** Scenario names become file names, which may be compared without regard to case, so a repeat gets a numeric suffix. */
function uniqueNames(list: Scenario[]): Scenario[] {
  const seen = new Set<string>();
  return list.map((s) => {
    let name = s.name;
    for (let n = 2; seen.has(name.toLowerCase()); n++) {
      name = `${s.name}-${n}`;
    }
    seen.add(name.toLowerCase());
    return name === s.name ? s : { ...s, name };
  });
}
