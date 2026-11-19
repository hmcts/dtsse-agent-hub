import { basename, dirname, join } from "node:path";
import type { DmnDecision, DmnDocument, DmnInput, DmnOutput, DmnRule, Inspection } from "./dmn-model.ts";
import { canonicalCell, canonicalExpr } from "./feel.ts";
import { exists, isDirectory, readText } from "./file-io.ts";
import { parseFileName } from "./file-names.ts";
import { align, byCodePoint } from "./merge.ts";
import { listTaskFiles, readDmnFile, type TaskFile } from "./task-files.ts";

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
  return JSON.stringify([
    rule.description || null,
    rule.inputs.map(canonicalCell),
    rule.outputs.map(canonicalExpr),
    (rule.inputLanguages ?? []).join("|"),
    (rule.outputLanguages ?? []).join("|")
  ]);
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
    i.allowedValues === undefined ? null : canonicalCell(i.allowedValues),
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
    if (!columnsEqual && (colA.length !== colB.length || outA.length !== outB.length)) {
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
    if (decision.table && other.table && decision.id !== other.id && parseFileName(`${decision.id}.dmn`)) {
      out.push({ file, decision: decision.name, message: `decision id differs: ${decision.id} vs ${other.id}` });
    }
    const required = (d: DmnDecision, names: Map<string, string>) => [...new Set(d.requires.map((id) => names.get(id) ?? id))].sort(byCodePoint);
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
  const valuesOf = (inspection: Inspection, construct: string) => [...(inspection.values.get(construct) ?? [])].sort(byCodePoint);
  const out: Difference[] = [];
  for (const construct of [...new Set([...a.unrepresentable.keys(), ...b.unrepresentable.keys()])].sort(byCodePoint)) {
    const [first, second] = [valuesOf(a, construct), valuesOf(b, construct)];
    if (first.length !== second.length) {
      out.push({ file, message: `${construct} occurs ${first.length} times in first and ${second.length} in second` });
    } else if (first.join("\n") !== second.join("\n")) {
      const short = (values: string[]) => values.join(", ").slice(0, 120);
      out.push({ file, message: `${construct} differs: ${short(first)} vs ${short(second)}` });
    }
  }
  return out;
}

/**
 * Compares two files, two directories file by file by name, or a file with the file of the same name in a directory. A path that
 * is missing, or a directory without that file, is an error.
 */
export function diffPaths(pathA: string, pathB: string, options: DiffOptions = {}): Difference[] {
  for (const path of [pathA, pathB]) {
    if (!exists(path)) {
      throw new Error(`${path} does not exist`);
    }
  }
  for (const [file, other] of [
    [pathA, pathB],
    [pathB, pathA]
  ] as const) {
    if (!isDirectory(file) && isDirectory(other) && !exists(join(other, basename(file)))) {
      throw new Error(`${other} has no file named ${basename(file)} to compare ${file} with`);
    }
  }
  const side = (path: string, counterpart: string): { dir: string; file?: string } => {
    if (!isDirectory(path)) {
      return { dir: dirname(path), file: basename(path) };
    }
    return isDirectory(counterpart) ? { dir: path } : { dir: path, file: basename(counterpart) };
  };
  return diffSides(side(pathA, pathB), side(pathB, pathA), options);
}

function diffSides(a: { dir: string; file?: string }, b: { dir: string; file?: string }, options: DiffOptions): Difference[] {
  const out: Difference[] = [];
  const pairs: Array<[TaskFile, TaskFile]> = [];
  if (a.file && b.file) {
    pairs.push([
      { name: a.file, xml: readText(join(a.dir, a.file)) },
      { name: b.file, xml: readText(join(b.dir, b.file)) }
    ]);
  } else {
    const [fa, fb] = [listTaskFiles(a.dir), listTaskFiles(b.dir)];
    const byKey = (files: TaskFile[], side: string) => {
      const map = new Map<string, TaskFile>();
      for (const file of files) {
        if (file.key === undefined) {
          if (file.name.startsWith("wa-task-")) {
            out.push({ file: file.name, message: `not a task DMN of a known kind, so not compared (${side})` });
          }
        } else if (map.has(file.key)) {
          out.push({ file: file.name, message: `${map.get(file.key)?.name} and ${file.name} both hold ${file.key} (${side})` });
        } else {
          map.set(file.key, file);
        }
      }
      return map;
    };
    const [ka, kb] = [byKey(fa, "first"), byKey(fb, "second")];
    for (const [key, file] of ka) {
      const other = kb.get(key);
      if (other) {
        pairs.push([file, other]);
      } else {
        out.push({ file: file.name, message: "file only in first" });
      }
    }
    for (const [key, file] of kb) {
      if (!ka.has(key)) {
        out.push({ file: file.name, message: "file only in second" });
      }
    }
  }
  for (const [first, second] of pairs) {
    const [x, y] = [readDmnFile(first.name, first.xml), readDmnFile(second.name, second.xml)];
    out.push(...diffInspections(first.name, x.inspection, y.inspection), ...diffDocuments(first.name, x.document, y.document, options));
  }
  return out;
}

export function renderDifferences(differences: Difference[]): string {
  return differences.map((d) => `${d.file}${d.decision ? ` [${d.decision}]` : ""}: ${d.message}`).join("\n");
}
