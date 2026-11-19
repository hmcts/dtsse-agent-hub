import { join } from "node:path";
import { type DmnDecision, type DmnDocument, type DmnInput, type DmnOutput, type DmnRule, type Inspection, readDmn } from "./dmn-model.ts";
import { canonicalCell, canonicalExpr } from "./feel.ts";
import { listDir, readText } from "./file-io.ts";
import { isWaTaskDmn } from "./file-names.ts";
import { align, byCodePoint } from "./merge.ts";

export interface DiffOptions {
  /** Compare rules as a set even where the hit policy makes their order matter. */
  ignoreRuleOrder?: boolean;
}

export interface Difference {
  file: string;
  decision?: string;
  message: string;
}

/**
 * Whether the order of a table's rules changes what it returns. FIRST stops at the first match, RULE ORDER
 * returns in order by definition, any policy the spec does not support is taken to be order-sensitive, and Camunda returns a plain COLLECT's matches in rule order, which
 * ET's tests assert on. UNIQUE and ANY return at most one distinct result, and an aggregated COLLECT is one value.
 */
export function ruleOrderMatters(hitPolicy: string, aggregation: string | undefined): boolean {
  if (hitPolicy === "UNIQUE" || hitPolicy === "ANY") {
    return false;
  }
  if (hitPolicy === "COLLECT" && aggregation !== undefined) {
    return false;
  }
  return true;
}

function ruleSignature(rule: DmnRule): string {
  return JSON.stringify([rule.description || null, rule.inputs.map(canonicalCell), rule.outputs.map(canonicalExpr)]);
}

function describeRule(rule: DmnRule, index: number): string {
  const text = [...rule.outputs, ...rule.inputs]
    .map((entry) => entry.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join(" | ");
  return `rule ${index + 1} (${text.length > 110 ? `${text.slice(0, 110)}...` : text})`;
}

const inputSignature = (i: DmnInput): string =>
  JSON.stringify([
    i.label ?? null,
    i.inputVariable ?? null,
    i.typeRef ?? null,
    i.expressionLanguage ?? null,
    i.allowedValues ?? null,
    canonicalExpr(i.expression)
  ]);

const outputSignature = (o: DmnOutput): string => JSON.stringify([o.label ?? null, o.name, o.typeRef ?? null]);

function diffDecision(file: string, a: DmnDecision, b: DmnDecision, options: DiffOptions, out: Difference[]): void {
  const at = (message: string) => out.push({ file, decision: a.name, message });
  if ((a.historyTimeToLive ?? "") !== (b.historyTimeToLive ?? "")) {
    at(`historyTimeToLive differs: ${a.historyTimeToLive} vs ${b.historyTimeToLive}`);
  }
  const variable = (d: DmnDecision) => JSON.stringify(d.variable ? { name: d.variable.name, typeRef: d.variable.typeRef } : null);
  if (variable(a) !== variable(b)) {
    at(`variable differs: ${variable(a)} vs ${variable(b)}`);
  }
  if (Boolean(a.table) !== Boolean(b.table) || Boolean(a.literal) !== Boolean(b.literal)) {
    at("one is a decision table and the other is not");
    return;
  }
  if (a.literal && b.literal) {
    if (canonicalExpr(a.literal.text) !== canonicalExpr(b.literal.text)) {
      at(`expression differs:\n    - ${a.literal.text.replace(/\s+/g, " ")}\n    + ${b.literal.text.replace(/\s+/g, " ")}`);
    }
    if ((a.literal.expressionLanguage ?? "") !== (b.literal.expressionLanguage ?? "")) {
      at("expression language differs");
    }
  }
  if (a.table && b.table) {
    const ta = a.table;
    const tb = b.table;
    if (ta.hitPolicy !== tb.hitPolicy || (ta.aggregation ?? "") !== (tb.aggregation ?? "")) {
      at(`hit policy differs: ${ta.hitPolicy} ${ta.aggregation ?? ""} vs ${tb.hitPolicy} ${tb.aggregation ?? ""}`);
    }
    const colA = ta.inputs.map(inputSignature);
    const colB = tb.inputs.map(inputSignature);
    const outA = ta.outputs.map(outputSignature);
    const outB = tb.outputs.map(outputSignature);
    let columnsEqual = true;
    for (const [what, x, y] of [
      ["input", colA, colB],
      ["output", outA, outB]
    ] as const) {
      if (x.length !== y.length) {
        at(`${what} count differs: ${x.length} vs ${y.length}`);
        columnsEqual = false;
      }
      x.forEach((column, index) => {
        if (index < y.length && column !== y[index]) {
          at(`${what} column ${index + 1} differs:\n    - ${column}\n    + ${y[index]}`);
          columnsEqual = false;
        }
      });
    }
    if (!columnsEqual) {
      return;
    }
    const sigA = ta.rules.map(ruleSignature);
    const sigB = tb.rules.map(ruleSignature);
    if (sigA.length !== sigB.length) {
      at(`rule count differs: ${sigA.length} vs ${sigB.length}`);
    }
    const ordered = ruleOrderMatters(ta.hitPolicy, ta.aggregation) && !options.ignoreRuleOrder;
    if (ordered) {
      for (const step of align(sigA, sigB)) {
        if (step.op === "del") {
          at(`only in first: ${describeRule(ta.rules[step.a] as DmnRule, step.a)}`);
        } else if (step.op === "add") {
          at(`only in second: ${describeRule(tb.rules[step.b] as DmnRule, step.b)}`);
        }
      }
    } else {
      const counts = new Map<string, number>();
      for (const s of sigA) {
        counts.set(s, (counts.get(s) ?? 0) + 1);
      }
      for (const s of sigB) {
        counts.set(s, (counts.get(s) ?? 0) - 1);
      }
      sigA.forEach((s, index) => {
        if ((counts.get(s) ?? 0) > 0) {
          counts.set(s, (counts.get(s) ?? 0) - 1);
          at(`only in first: ${describeRule(ta.rules[index] as DmnRule, index)}`);
        }
      });
      sigB.forEach((s, index) => {
        if ((counts.get(s) ?? 0) < 0) {
          counts.set(s, (counts.get(s) ?? 0) + 1);
          at(`only in second: ${describeRule(tb.rules[index] as DmnRule, index)}`);
        }
      });
    }
  }
}

/** Decisions keyed by name and, for a name used more than once, by order of occurrence. */
function keyedDecisions(doc: DmnDocument): { byKey: Map<string, DmnDecision>; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const byKey = new Map<string, DmnDecision>();
  for (const decision of doc.decisions) {
    const seen = counts.get(decision.name) ?? 0;
    counts.set(decision.name, seen + 1);
    byKey.set(`${decision.name}#${seen}`, decision);
  }
  return { byKey, counts };
}

/**
 * Compares two DMNs as data: decisions by name, then hit policy, columns and rules. Ids, whitespace and layout are
 * ignored, except the id of a decision table, which is the key Camunda evaluates it by. Rule order is ignored wherever
 * `ruleOrderMatters` says it cannot change a result, and so is decision order; required decisions are compared by name.
 * Decisions that share a name are matched by order of occurrence and reported, as a name should identify one decision.
 */
export function diffDocuments(file: string, a: DmnDocument, b: DmnDocument, options: DiffOptions = {}): Difference[] {
  const out: Difference[] = [];
  const nameById = (doc: DmnDocument) => new Map(doc.decisions.map((d) => [d.id, d.name]));
  const na = nameById(a);
  const nb = nameById(b);
  const da = keyedDecisions(a);
  const db = keyedDecisions(b);
  for (const name of new Set([...da.counts.keys(), ...db.counts.keys()])) {
    const [first, second] = [da.counts.get(name) ?? 0, db.counts.get(name) ?? 0];
    if (first > 1 || second > 1) {
      out.push({ file, decision: name, message: `decision name used ${first} times in first and ${second} in second` });
    }
  }
  for (const [key, decision] of da.byKey) {
    const other = db.byKey.get(key);
    if (!other) {
      out.push({ file, decision: decision.name, message: "decision only in first" });
      continue;
    }
    if (decision.table && other.table && decision.id !== other.id) {
      out.push({ file, decision: decision.name, message: `decision id differs: ${decision.id} vs ${other.id}` });
    }
    const required = (d: DmnDecision, names: Map<string, string>) => d.requires.map((id) => names.get(id) ?? id).sort(byCodePoint);
    if (JSON.stringify(required(decision, na)) !== JSON.stringify(required(other, nb))) {
      out.push({ file, decision: decision.name, message: `requires differ: ${required(decision, na).join(", ")} vs ${required(other, nb).join(", ")}` });
    }
    diffDecision(file, decision, other, options, out);
  }
  for (const [key, decision] of db.byKey) {
    if (!da.byKey.has(key)) {
      out.push({ file, decision: decision.name, message: "decision only in second" });
    }
  }
  return out;
}

/** Constructs the model does not carry, which a diff of models cannot see: each one that occurs a different number of times on the two sides. */
export function diffInspections(file: string, a: Inspection, b: Inspection): Difference[] {
  return [...new Set([...a.unrepresentable.keys(), ...b.unrepresentable.keys()])]
    .filter((construct) => (a.unrepresentable.get(construct) ?? 0) !== (b.unrepresentable.get(construct) ?? 0))
    .sort(byCodePoint)
    .map((construct) => ({
      file,
      message: `${construct} occurs ${a.unrepresentable.get(construct) ?? 0} times in first and ${b.unrepresentable.get(construct) ?? 0} in second`
    }));
}

const dmnFiles = (dir: string): string[] => listDir(dir).filter(isWaTaskDmn).sort(byCodePoint);

/** Compares two files, or two directories file by file by name. */
export function diffPaths(a: { dir: string; file?: string }, b: { dir: string; file?: string }, options: DiffOptions = {}): Difference[] {
  const out: Difference[] = [];
  const names = a.file && b.file ? [[a.file, b.file]] : [];
  if (!a.file || !b.file) {
    const fa = dmnFiles(a.dir);
    const fb = dmnFiles(b.dir);
    for (const name of fa) {
      if (!fb.includes(name)) {
        out.push({ file: name, message: "file only in first" });
      } else {
        names.push([name, name]);
      }
    }
    for (const name of fb) {
      if (!fa.includes(name)) {
        out.push({ file: name, message: "file only in second" });
      }
    }
  }
  for (const [nameA, nameB] of names) {
    const first = readDmn(readText(join(a.dir, nameA as string)));
    const second = readDmn(readText(join(b.dir, nameB as string)));
    out.push(
      ...diffInspections(nameA as string, first.inspection, second.inspection),
      ...diffDocuments(nameA as string, first.document, second.document, options)
    );
  }
  return out;
}

export function renderDifferences(differences: Difference[]): string {
  return differences.map((d) => `${d.file}${d.decision ? ` [${d.decision}]` : ""}: ${d.message}`).join("\n");
}
