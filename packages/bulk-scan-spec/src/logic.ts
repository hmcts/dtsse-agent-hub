import type { Assignment, Operand, Outcome, Rule, Scalar } from "./schema.ts";
import { isNegation, isTickedTest } from "./schema.ts";

export interface LogicContext {
  keys: string[];
  ccd: string[];
  /** Whether a sheet id such as "2.4" names a row whose values the logic may test. */
  knowsId?: (id: string) => boolean;
  /** Every OCR key of the form, which a row's logic may test even when it belongs to another row. */
  allKeys?: string[];
  /** Keys of the row above and the rows below, which the sheet points at as "(field above)" and "(below)". */
  aboveKeys?: string[];
  belowFields?: { keys: string[]; label: string }[];
  /** Letters the preamble defines for a key or a CCD id, e.g. "detailsOnCertCorrect (a)". */
  aliases?: Map<string, { name: string; kind: "key" | "ccd" }>;
}

export type LogicParse =
  | { parsed: true; rules: Rule[]; preamble?: string; fragments: number; neverExceeds?: Outcome }
  | { parsed: false; reason: string; neverExceeds?: Outcome };

const IDENT = "[A-Za-z][A-Za-z0-9_]*";
const REF = "\\d+[a-z]?";
const NOTE_FRAGMENTS = /\(\s*(?:WITH\s+)?WARNING\s*\)|↓|Note:[\s\S]*$|\(just pass it through\)|\(i\.e[^)]*\)/gi;
const PASS_THROUGH = new RegExp(`^(${IDENT})\\s*=\\s*(${IDENT})(\\s*\\(just pass it through\\))?$`);
const SUBJECT = `(?:\\d+\\.\\d+|${IDENT})`;
const ATOM = new RegExp(`^(${SUBJECT})\\s*(?:(!=|=)\\s*(!)?\\s*['"]?(\\w+(?:,\\w+)*)['"]?|(!)\\s*(null))`);

function scalar(token: string): Scalar {
  const lower = token.toLowerCase();
  if (lower === "null") {
    return null;
  }
  if (lower === "true") {
    return true;
  }
  if (lower === "false") {
    return false;
  }
  return token;
}

export function parseNeverExceeds(casePath: string): Outcome | undefined {
  if (/cannot go into (?:a )?warning or\s+exception/i.test(casePath)) {
    return "success";
  }
  if (/cannot go into (?:an? )?exception/i.test(casePath)) {
    return "warning";
  }
  return undefined;
}

export function parseOutcomes(casePath: string): Map<string, Outcome> {
  const outcomes = new Map<string, Outcome>();
  for (const line of casePath.split("\n")) {
    const m = new RegExp(`^\\s*(${REF})\\)?\\s*=?\\s*(success|warning|exception)\\b`, "i").exec(line);
    if (m?.[1] && m[2]) {
      outcomes.set(m[1], m[2].toLowerCase() as Outcome);
    }
  }
  return outcomes;
}

function toAssignment(value: string, keys: string[]): Assignment {
  return keys.includes(value) ? { from: value } : scalar(value);
}

function parseAssignments(text: string, ctx: LogicContext): Rule["set"] | undefined {
  const set: Record<string, Assignment> = {};
  const rest = text.replace(new RegExp(`(${IDENT})\\s*=\\s*(\\w+)`, "g"), (_m, target: string, value: string) => {
    const left = ctx.aliases?.get(target);
    const right = ctx.aliases?.get(value);
    if (left?.kind === "key" && right?.kind === "ccd") {
      // "a = b" where a stands for a key and b for a CCD field copies the key into the field.
      set[right.name] = { from: left.name };
    } else {
      set[target] = toAssignment(value, ctx.keys);
    }
    return " ";
  });
  if (rest.replace(/[\s,]/g, "") !== "") {
    return undefined;
  }
  return set;
}

interface Block {
  separator: "if" | "else-if" | "else";
  text: string;
  independent?: boolean;
}

const REF_LINE = new RegExp(`^\\s*${REF}\\)`);

function splitBlocks(segment: string): Block[] {
  const blocks: Block[] = [];
  let separator: Block["separator"] = "if";
  let independent = false;
  let current: string[] = [];
  const flush = () => {
    const text = current.join("\n").trim();
    if (text) {
      blocks.push({ separator, text, ...(independent ? { independent } : {}) });
    }
    current = [];
    independent = false;
  };
  for (const line of segment.split("\n")) {
    const trimmed = line.trim();
    if (/^ELSE\s+IF\b/i.test(trimmed)) {
      flush();
      separator = "else-if";
      const tail = trimmed.replace(/^ELSE\s+IF\s*:?/i, "").trim();
      if (tail) {
        current.push(tail);
      }
    } else if (/^ELSE\b/i.test(trimmed)) {
      flush();
      separator = "else";
      const tail = trimmed.replace(/^ELSE\s*:?/i, "").trim();
      if (tail && !/^\(/.test(tail)) {
        current.push(tail);
      }
    } else if (REF_LINE.test(line) && current.some((c) => c.trim() !== "" && REF_LINE.test(c))) {
      // A second numbered line with no ELSE between is a branch of its own.
      flush();
      separator = "if";
      independent = true;
      current.push(line);
    } else {
      current.push(line);
    }
  }
  flush();
  return blocks;
}

/** A name the logic may use for a key or CCD id: a sheet id, a letter the preamble defined, a key of this or another row, or a CCD id. */
function resolveSubject(subject: string, ctx: LogicContext): string | undefined {
  if (/^\d/.test(subject)) {
    return ctx.knowsId?.(subject) ? subject : undefined;
  }
  const alias = ctx.aliases?.get(subject);
  if (alias) {
    return alias.kind === "key" ? alias.name : `ccd:${alias.name}`;
  }
  const pool = [...ctx.keys, ...(ctx.allKeys ?? [])];
  const key = pool.find((k) => k === subject) ?? pool.find((k) => k.toLowerCase() === subject.toLowerCase());
  if (key) {
    return key;
  }
  return ctx.ccd.includes(subject) ? `ccd:${subject}` : undefined;
}

const AT_LEAST_ONE = /^at least (?:1|one) of the \w+ source fields = null/i;
const ALL_POPULATED = /^all (?:\d+|\w+) source fields are populated/i;

type Conjunction = Record<string, Operand>;

/** One condition read from the text: terms that all must hold, or alternatives of which one must. */
interface Atom {
  length: number;
  all?: Conjunction;
  any?: Conjunction[];
  /** The subject is already a resolved key, and the condition is a phrase rather than a plain "key = value". */
  extended?: boolean;
  subject?: string;
}

const IS_BLANK = new RegExp(
  `^((?:the )?field|\\(this field\\)|\\(email address field above\\)|\\(field above\\)|${SUBJECT})\\s+is\\s+(not\\s+)?(blank|empty|null|completed|populated)\\b`,
  "i"
);
const BELOW = /^([A-Za-z ]+(?:\/[A-Za-z ]+)+)\s*\(below\)\s*(!=|=|!)\s*null/i;
const PHRASE_SUBJECT = /^(\(this field\)|\(email address field above\)|\(field above\))\s*(?:(!=|=)\s*(!)?\s*['"]?(\w+(?:,\w+)*)['"]?|(!)\s*(null))/i;

function phraseKey(phrase: string, ctx: LogicContext): string | undefined {
  const p = phrase.toLowerCase();
  if (p === "field" || p === "the field" || p === "(this field)") {
    return ctx.keys[0];
  }
  return ctx.aboveKeys?.[0];
}

function nextAtom(body: string, ctx: LogicContext): Atom | undefined {
  const all = ALL_POPULATED.exec(body);
  if (all && ctx.keys.length > 1) {
    return { length: all[0].length, all: Object.fromEntries(ctx.keys.map((k) => [k, { not: null }])), extended: true };
  }
  const below = BELOW.exec(body);
  if (below?.[1]) {
    const keys = below[1]
      .split("/")
      .flatMap((part) => ctx.belowFields?.find((f) => f.label.toLowerCase().includes(part.trim().toLowerCase()))?.keys.slice(0, 1) ?? []);
    if (keys.length === 0) {
      return undefined;
    }
    const absent = below[2] === "=";
    return {
      length: below[0].length,
      extended: true,
      ...(absent ? { any: keys.map((k) => ({ [k]: null })) } : { all: Object.fromEntries(keys.map((k) => [k, { not: null }])) })
    };
  }
  const blank = IS_BLANK.exec(body);
  if (blank?.[1]) {
    const phrase = /^(?:the )?field$|^\(/i.test(blank[1]);
    const key = phrase ? phraseKey(blank[1], ctx) : undefined;
    const subject = phrase ? key : blank[1];
    if (!subject) {
      return undefined;
    }
    // "completed" and "populated" say the field has a value; "blank", "empty" and "null" say it has none; "not" reverses either.
    const saysValue = /^(?:completed|populated)$/i.test(blank[3] ?? "");
    const empty = saysValue === !!blank[2];
    return { length: blank[0].length, subject, extended: phrase, all: { [subject]: empty ? null : { not: null } } };
  }
  const phrase = PHRASE_SUBJECT.exec(body);
  if (phrase?.[1]) {
    const key = phraseKey(phrase[1], ctx);
    if (!key) {
      return undefined;
    }
    const negated = phrase[2] === "!=" || phrase[3] === "!" || phrase[5] === "!";
    const operand = phrase[5] ? null : scalar(phrase[4] ?? "");
    return { length: phrase[0].length, extended: true, subject: key, all: { [key]: negated ? { not: operand } : operand } };
  }
  const atom = ATOM.exec(body);
  if (!atom?.[1]) {
    return undefined;
  }
  const [whole, subject, op, bang, value, shortBang] = atom;
  const negated = op === "!=" || bang === "!" || shortBang === "!";
  const operand = shortBang ? null : scalar(value ?? "");
  return { length: whole.length, subject, all: { [subject]: negated ? { not: operand } : operand } };
}

/** Terms joined by AND bind tighter than OR; "and:" before a list means the preceding terms hold together with one of the list. */
function parseConditions(input: string, ctx: LogicContext): { groups: Conjunction[]; rest: string; extended: boolean } | string {
  const anyNull = AT_LEAST_ONE.exec(input);
  if (anyNull && ctx.keys.length > 1) {
    return {
      extended: false,
      groups: ctx.keys.map((k) => ({ [k]: null })),
      rest: input
        .slice(anyNull[0].length)
        .replace(/^[,:]\s*/, "")
        .trim()
    };
  }
  let body = input.replace(/,\s*(and|or)\b/gi, " $1").replace(/\b(OR)\s+OR\b/gi, "$1");
  const finished: Conjunction[] = [];
  let current: Conjunction[] = [{}];
  let base: Conjunction[] | undefined;
  let expectAtom = false;
  let extended = false;
  const resolved = (subject: string | undefined) =>
    subject ? (resolveSubject(subject, ctx) ?? (ctx.keys.includes(subject) ? subject : undefined)) : undefined;
  for (;;) {
    const atom = nextAtom(body, ctx);
    if (!atom) {
      break;
    }
    extended ||= !!atom.extended;
    const term: Conjunction | undefined = atom.all;
    if (term) {
      const entries: Conjunction = {};
      for (const [name, operand] of Object.entries(term)) {
        const key = atom.extended ? name : resolveSubject(name, ctx);
        if (!key) {
          return `cannot test "${name}": it is neither a key of the form, a CCD id this row writes, nor a known sheet id`;
        }
        entries[key] = operand;
      }
      current = current.map((c) => ({ ...c, ...entries }));
    }
    if (atom.any) {
      current = current.flatMap((c) => (atom.any as Conjunction[]).map((alt) => ({ ...c, ...alt })));
    }
    body = body.slice(atom.length).trim();
    expectAtom = false;
    // A comma joins two tests when the second is about a key; before a CCD id it is the start of the assignment.
    const comma = /^,\s*/.exec(body);
    if (comma) {
      const peek = nextAtom(body.slice(comma[0].length), ctx);
      const asKey = peek?.extended || (peek?.subject !== undefined && !resolved(peek.subject)?.startsWith("ccd:") && resolved(peek.subject) !== undefined);
      const copiesIntoCcd = Object.values(peek?.all ?? {}).some((v) => typeof v === "string" && (ctx.ccd.includes(v) || ctx.aliases?.get(v)?.kind === "ccd"));
      if (peek && asKey && !copiesIntoCcd) {
        body = body.slice(comma[0].length);
        extended = true;
        expectAtom = false;
        continue;
      }
    }
    const connector = /^(AND|OR)(:?)\s+/i.exec(body);
    if (!connector) {
      break;
    }
    body = body.slice(connector[0].length);
    expectAtom = true;
    if (/^and$/i.test(connector[1] ?? "") && connector[2]) {
      base = current;
      current = [{}];
      extended = true;
    } else if (/^or$/i.test(connector[1] ?? "")) {
      finished.push(...current);
      current = [{}];
    }
  }
  // AND and OR alike must be followed by a condition we can read; anything else fails the whole condition.
  const alternatives = [...finished, ...current];
  const groups = base ? base.flatMap((b) => alternatives.map((a) => ({ ...b, ...a }))) : alternatives;
  if (expectAtom || groups.some((g) => Object.keys(g).length === 0)) {
    return `cannot read the condition of "${input.slice(0, 80)}"`;
  }
  return { groups, rest: body.replace(/^[,:]\s*/, "").trim(), extended };
}

const OUTCOME_WORD = /^(?:(?:validation\s+)?status\s*=\s*|case path\s*=\s*)?(?:(suc+es+s?)|(warning)|(exception))$/i;

function outcomeOf(word: string): Outcome | undefined {
  const m = OUTCOME_WORD.exec(word.trim());
  return m ? (m[1] ? "success" : m[2] ? "warning" : "exception") : undefined;
}

/** English the parser kept is written in square brackets, so that reading it back cannot take it for a condition. */
function unbracket(text: string): string {
  return /^\[[\s\S]*\]$/.test(text) ? text.slice(1, -1) : text;
}

/** A rule and how many English fragments (conditions or actions the parser could not read) it keeps. */
function parseBlock(block: Block, ctx: LogicContext): { rule: Rule; fragments: number } {
  const notes = block.text.match(NOTE_FRAGMENTS) ?? [];
  const text = block.text.replace(NOTE_FRAGMENTS, " ").replace(/\s+/g, " ").trim();
  const refMatch = new RegExp(`^(${REF})\\)\\s*(.*)$`).exec(text);
  const ref = refMatch?.[1];
  const afterRef = unbracket(refMatch ? (refMatch[2] ?? "") : text);
  let body = afterRef;
  const rule: Rule = {};
  if (ref) {
    rule.ref = ref;
  }
  if (notes.length > 0) {
    rule.note = notes.map((n) => n.trim()).join(" ");
  }
  if (block.independent) {
    rule.independent = true;
  }
  const english = () => {
    rule.action = afterRef;
    if (block.separator === "else") {
      rule.otherwise = true;
    }
    const trailing = /[,\s]\s*(suc+es+|warning|exception)\s*$/i.exec(afterRef);
    const outcome = trailing?.[1] ? outcomeOf(trailing[1]) : undefined;
    if (outcome) {
      rule.outcome = outcome;
    }
    return { rule, fragments: 1 };
  };

  if (block.separator === "else") {
    rule.otherwise = true;
  } else {
    const hasIf = /^if\s+/i.test(body);
    body = body.replace(/^if\s+/i, "");
    // Without "If" a first numbered line is an assignment ("1b) a = b"); only a branch after ELSE IF may drop the word.
    const parsed = !hasIf && block.separator === "if" ? "" : parseConditions(body, ctx);
    // "a = b" with nothing after it is an assignment when it sets a CCD field or copies into one; with a phrase or a key test it is a condition.
    const assignmentLike = (p: Exclude<typeof parsed, string>) =>
      !p.extended &&
      p.groups.length === 1 &&
      Object.entries(p.groups[0] ?? {}).every(([k, v]) => k.startsWith("ccd:") || (typeof v === "string" && ctx.ccd.includes(v)));
    if (typeof parsed !== "string" && !hasIf && parsed.rest === "" && assignmentLike(parsed)) {
      body = afterRef;
      if (block.separator === "else-if") {
        // "ELSE IF" with nothing to test is the chain's final branch.
        rule.otherwise = true;
      }
    } else if (typeof parsed === "string") {
      if (hasIf || block.separator === "else-if" || !ref) {
        return english();
      }
    } else {
      const [first, ...more] = parsed.groups;
      if (more.length > 0) {
        rule.whenAny = parsed.groups;
      } else if (first) {
        rule.when = first;
      }
      body = parsed.rest;
    }
  }

  // Assignments may be followed by more conditions: "x = Yes AND key = a OR key = b".
  const trailingConditions = /^((?:\w+\s*=\s*\w+[,\s]*)+?)\s+AND\s+(.+)$/i.exec(body);
  if (trailingConditions?.[1] && trailingConditions[2] && parseAssignments(trailingConditions[1], ctx)) {
    const extra = parseConditions(trailingConditions[2], ctx);
    if (typeof extra !== "string") {
      const before = rule.whenAny ?? (rule.when ? [rule.when] : [{}]);
      const crossed = before.flatMap((b) => extra.groups.map((g) => ({ ...b, ...g })));
      delete rule.when;
      delete rule.whenAny;
      if (crossed.length > 1) {
        rule.whenAny = crossed;
      } else if (crossed[0]) {
        rule.when = crossed[0];
      }
      body = [trailingConditions[1].trim(), extra.rest].filter(Boolean).join(", ");
    }
  }

  const inline = /\(\s*(success|warning|exception)\s*\)\s*$/i.exec(body);
  if (inline?.[1]) {
    rule.outcome = inline[1].toLowerCase() as Outcome;
    body = body.slice(0, inline.index).trim();
  }
  if (/^pass through\b/i.test(body)) {
    // A description of the transformation, which the validator does not need.
    rule.note = [rule.note, `Note: ${body}`].filter(Boolean).join(" ");
    return { rule, fragments: 0 };
  }
  // The sheet's shorthand "ccdField = success" states the branch's case path.
  const shorthand = new RegExp(`^(${IDENT})\\s*=\\s*(suc+es+s?|warning|exception)$`, "i").exec(body);
  if (shorthand?.[1] && shorthand[2] && ctx.ccd.includes(shorthand[1])) {
    rule.outcome = outcomeOf(shorthand[2]);
    return { rule, fragments: 0 };
  }
  const outcome = outcomeOf(body);
  if (outcome || /^raise warning$/i.test(body)) {
    rule.outcome = outcome ?? "warning";
    return { rule, fragments: 0 };
  }
  const word = /[,\s]+(suc+es+s?|warning|exception)\s*$/i.exec(body);
  const assignments = word ? body.slice(0, word.index).trim() : body;
  const set = parseAssignments(assignments, ctx);
  if (!set) {
    if (rule.when || rule.whenAny) {
      rule.action = unbracket(body);
      return { rule, fragments: 1 };
    }
    return english();
  }
  if (word?.[1]) {
    rule.outcome = outcomeOf(word[1]);
  }
  if (Object.keys(set).length > 0) {
    rule.set = set;
  }
  return { rule, fragments: 0 };
}

function passThroughRules(lines: string[], ctx: LogicContext): Rule[] | string | undefined {
  const matches = lines.map((l) => PASS_THROUGH.exec(l));
  if (matches.length === 0 || matches.some((m) => m === null)) {
    return undefined;
  }
  const rules: Rule[] = [];
  for (const m of matches) {
    const [, left, right, note] = m as RegExpExecArray;
    if (!left || !right) {
      continue;
    }
    if (left === right && ctx.keys.includes(left) && ctx.ccd.includes(left)) {
      const same: Rule = { set: { [left]: { from: left } } };
      if (note) {
        same.note = note.trim();
      }
      rules.push(same);
      continue;
    }
    const own = (n: string) => ctx.keys.includes(n);
    const other = (n: string) => !own(n) && (ctx.allKeys ?? []).some((k) => k.toLowerCase() === n.toLowerCase());
    const leftCcd = ctx.ccd.includes(left);
    const rightCcd = ctx.ccd.includes(right);
    let rule: Rule;
    if (leftCcd && own(right)) {
      rule = { set: { [left]: { from: right } } };
    } else if (rightCcd && own(left)) {
      rule = { set: { [right]: { from: left } } };
    } else if (leftCcd && !own(right) && !other(right) && !rightCcd && !note) {
      // A constant: the CCD field is set to a literal. (With "just pass it through" it would be a copy, and a copy from a name that is no key is a sheet error.)
      rule = { set: { [left]: scalar(right) } };
    } else if (other(left) || other(right) || (own(left) && own(right))) {
      return `"${left} = ${right}" does not link one of this row's keys to one of its CCD ids (a sheet error)`;
    } else {
      return undefined;
    }
    if (note) {
      rule.note = note.trim();
    }
    rules.push(rule);
  }
  return rules;
}

/** Letters a preamble gives to a key and a CCD field: "detailsOnCertCorrect (a) = marriageCertifyIsCorrect (b)". */
function parseAliases(preamble: string, ctx: LogicContext): Map<string, { name: string; kind: "key" | "ccd" }> {
  const aliases = new Map<string, { name: string; kind: "key" | "ccd" }>();
  for (const line of preamble.split("\n")) {
    const m = new RegExp(`^\\s*(${IDENT})\\s*\\((\\w)\\)\\s*=\\s*(${IDENT})\\s*\\((\\w)\\)\\s*$`).exec(line);
    if (m?.[1] && m[2] && m[3] && m[4] && ctx.keys.includes(m[1]) && ctx.ccd.includes(m[3])) {
      aliases.set(m[2], { name: m[1], kind: "key" });
      aliases.set(m[4], { name: m[3], kind: "ccd" });
    }
  }
  return aliases;
}

/** Reads a transformation sheet's English logic into rules, or says why it cannot. */
export function parseLogic(logic: string, casePath: string, ctx: LogicContext): LogicParse {
  const neverExceeds = parseNeverExceeds(casePath);
  const text = logic.replace(/\r/g, "").trim();
  if (!text) {
    return { parsed: false, reason: "no logic", neverExceeds };
  }

  const lines = text.split("\n");
  const plain = lines.map((l) => l.trim()).filter(Boolean);
  const pass = passThroughRules(plain, ctx);
  if (typeof pass === "string") {
    return { parsed: false, reason: pass, neverExceeds };
  }
  if (pass) {
    return { parsed: true, rules: pass, fragments: 0, neverExceeds };
  }

  const always = /^always\s+(success|warning|exception)$/i.exec(text);
  if (always?.[1]) {
    const rule: Rule = { otherwise: true, outcome: always[1].toLowerCase() as Outcome };
    const [label, ...more] = [...parseOutcomes(casePath).keys()];
    if (label && more.length === 0) {
      rule.ref = label;
    }
    return { parsed: true, rules: [rule], fragments: 0, neverExceeds };
  }

  const firstRef = lines.findIndex((l) => REF_LINE.test(l));
  if (firstRef < 0) {
    if (/^(?:Map (?:multiple|two)|TRANSFORMATION)/i.test(text)) {
      return { parsed: true, rules: [], preamble: text, fragments: 0, neverExceeds };
    }
    return { parsed: false, reason: "prose with no numbered branches", neverExceeds };
  }
  const preamble = lines.slice(0, firstRef).join("\n").trim() || undefined;
  const chain = lines.slice(firstRef).join("\n");

  const outcomes = parseOutcomes(casePath);
  const aliased: LogicContext = { ...ctx, aliases: parseAliases(preamble ?? "", ctx) };
  const rules: Rule[] = [];
  let fragments = 0;
  for (const [segmentIndex, segment] of chain.split(/\n\s*-{3,}\s*\n/).entries()) {
    for (const [blockIndex, block] of splitBlocks(segment).entries()) {
      if (segmentIndex > 0 && blockIndex === 0) {
        block.independent = true;
      }
      const { rule, fragments: found } = parseBlock(block, aliased);
      fragments += found;
      if (rule.ref) {
        const outcome = outcomes.get(rule.ref);
        if (outcome) {
          rule.outcome = outcome;
        } else if (!rule.outcome) {
          return { parsed: false, reason: `no case path for branch ${rule.ref}`, neverExceeds };
        }
      }
      rules.push(rule);
    }
  }
  // A branch the logic leaves unlabelled takes the case path's labels that no labelled branch claims, in order.
  const claimed = new Set(rules.flatMap((r) => (r.ref ? [r.ref] : [])));
  const spare = [...outcomes].filter(([label]) => !claimed.has(label));
  for (const rule of rules.filter((r) => !r.ref)) {
    const next = spare.shift();
    if (next) {
      rule.ref = next[0];
      rule.outcome = next[1];
    }
  }
  if (rules.length === 0) {
    return { parsed: false, reason: "no branches found", neverExceeds };
  }
  // Every numbered branch in the text must appear in the rules; one that does not is English the parser dropped.
  const present = new Set(rules.map((r) => r.ref));
  const labels = [...chain.matchAll(new RegExp(`(?:^|\\n)\\s*(?:ELSE\\s+IF\\s+)?(${REF})\\)`, "gi"))].map((m) => m[1]);
  fragments += labels.filter((label) => !present.has(label)).length;
  return { parsed: true, rules, preamble, fragments, neverExceeds };
}

function renderScalar(value: Scalar): string {
  return value === null ? "null" : String(value);
}

function renderOperand(key: string, operand: Operand): string {
  const name = key.replace(/^ccd:/, "");
  if (isTickedTest(operand)) {
    return `${name} is ${operand.ticked ? "" : "not "}ticked`;
  }
  if (isNegation(operand)) {
    return `${name} != ${renderScalar(operand.not)}`;
  }
  return `${name} = ${renderScalar(operand)}`;
}

function renderConjunction(c: Record<string, Operand>): string {
  return Object.entries(c)
    .map(([k, v]) => renderOperand(k, v))
    .join(" AND ");
}

function renderSet(set: NonNullable<Rule["set"]>): string {
  return Object.entries(set)
    .map(([target, value]) => {
      if (value !== null && typeof value === "object") {
        return `${target} = ${value.from}`;
      }
      return `${target} = ${renderScalar(value)}`;
    })
    .join(", ");
}

function isPassThrough(rule: Rule): boolean {
  return !rule.when && !rule.whenAny && !rule.otherwise && !rule.ref && !rule.outcome && !!rule.set;
}

function renderPassThrough(rule: Rule): string {
  const [target, value] = Object.entries(rule.set ?? {})[0] ?? [];
  const source = value !== null && typeof value === "object" ? value.from : renderScalar(value as Scalar);
  const body = `${target} = ${source}`;
  return rule.note ? `${body} ${rule.note}` : body;
}

/** The generator's own phrasing of rules; {@link parseLogic} reads it back to the same rules. */
export function renderLogic(rules: Rule[], preamble?: string): string {
  const lead = preamble ? `${preamble}\n\n` : "";
  if (rules.length === 0) {
    return preamble ?? "";
  }
  if (rules.every(isPassThrough)) {
    return lead + rules.map(renderPassThrough).join("\n");
  }
  const only = rules.length === 1 ? rules[0] : undefined;
  if (only?.otherwise && !only.set && only.outcome) {
    return `${lead}Always ${only.outcome}`;
  }
  const parts = rules.map((rule, i) => {
    const label = rule.ref ? `${rule.ref}) ` : "";
    // A branch with a label has its outcome in the case path; one without writes it after its assignment.
    const tail = rule.set
      ? `${renderSet(rule.set)}${!rule.ref && rule.outcome ? ` (${rule.outcome})` : ""}`
      : rule.action !== undefined
        ? `[${rule.action}]`
        : (rule.outcome ?? "");
    const note = rule.note ? ` ${rule.note}` : "";
    if (rule.otherwise) {
      return `ELSE\n\n${label}${tail}${note}`.trimEnd();
    }
    const cond = rule.whenAny ? rule.whenAny.map(renderConjunction).join("\nOR\n") : renderConjunction(rule.when ?? {});
    const head = cond ? `${label}If ${cond}${tail ? `, ${tail}` : ""}${note}` : `${label}${tail}${note}`;
    if (i === 0) {
      return head;
    }
    return rule.independent || (!rule.when && !rule.whenAny && rule.action === undefined) ? `--------\n\n${head}` : `ELSE IF\n\n${head}`;
  });
  return lead + parts.join("\n\n");
}

export function renderCasePath(rules: Rule[], neverExceeds: Outcome | undefined): string {
  const lines = rules.filter((r) => r.ref && r.outcome).map((r) => `${r.ref}) = ${r.outcome}`);
  const trailer =
    neverExceeds === "warning"
      ? "Record cannot go into exception based on this attribute"
      : neverExceeds === "success"
        ? "Record cannot go into warning or exception based on this attribute"
        : "";
  return [lines.join("\n\n"), trailer].filter(Boolean).join("\n\n");
}
