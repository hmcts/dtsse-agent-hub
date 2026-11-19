import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type DmnDecision, type DmnDocument, type DmnRule, parseDmn } from "./dmn-model.ts";
import { canonicalCell, canonicalExpr } from "./feel.ts";

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
 * Whether the order of a table's rules changes what it returns. FIRST stops at the first match, RULE ORDER and
 * OUTPUT ORDER return in order by definition, and Camunda returns a plain COLLECT's matches in rule order, which
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
  return JSON.stringify([rule.description ?? null, rule.inputs.map(canonicalCell), rule.outputs.map(canonicalExpr)]);
}

function describeRule(rule: DmnRule, index: number): string {
  const text = [...rule.outputs, ...rule.inputs]
    .map((entry) => entry.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join(" | ");
  return `rule ${index + 1} (${text.length > 110 ? `${text.slice(0, 110)}...` : text})`;
}

/** Edit script between two signature lists, by longest common subsequence. */
function editScript(a: string[], b: string[]): Array<{ op: "keep" | "del" | "add"; index: number }> {
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      (lcs[i] as number[])[j] =
        a[i] === b[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as number[])[j] as number, (lcs[i] as number[])[j + 1] as number);
    }
  }
  const out: Array<{ op: "keep" | "del" | "add"; index: number }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ op: "keep", index: i });
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && ((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number))) {
      out.push({ op: "del", index: i });
      i++;
    } else {
      out.push({ op: "add", index: j });
      j++;
    }
  }
  return out;
}

function diffDecision(file: string, a: DmnDecision, b: DmnDecision, options: DiffOptions, out: Difference[]): void {
  const at = (message: string) => out.push({ file, decision: a.name, message });
  if (a.name !== b.name) {
    at(`name differs: ${JSON.stringify(a.name)} vs ${JSON.stringify(b.name)}`);
  }
  if ((a.historyTimeToLive ?? "") !== (b.historyTimeToLive ?? "")) {
    at(`historyTimeToLive differs: ${a.historyTimeToLive} vs ${b.historyTimeToLive}`);
  }
  if (JSON.stringify(a.variable ?? null) !== JSON.stringify(b.variable ?? null)) {
    at(`variable differs: ${JSON.stringify(a.variable)} vs ${JSON.stringify(b.variable)}`);
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
    const colA = ta.inputs.map((i) =>
      JSON.stringify([i.label ?? null, i.inputVariable ?? null, i.typeRef ?? null, i.expressionLanguage ?? null, canonicalExpr(i.expression)])
    );
    const colB = tb.inputs.map((i) =>
      JSON.stringify([i.label ?? null, i.inputVariable ?? null, i.typeRef ?? null, i.expressionLanguage ?? null, canonicalExpr(i.expression)])
    );
    const outA = ta.outputs.map((o) => JSON.stringify([o.label ?? null, o.name, o.typeRef ?? null]));
    const outB = tb.outputs.map((o) => JSON.stringify([o.label ?? null, o.name, o.typeRef ?? null]));
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
      for (const step of editScript(sigA, sigB)) {
        if (step.op === "del") {
          at(`only in first: ${describeRule(ta.rules[step.index] as DmnRule, step.index)}`);
        } else if (step.op === "add") {
          at(`only in second: ${describeRule(tb.rules[step.index] as DmnRule, step.index)}`);
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

/**
 * Compares two DMNs as data: decisions by name, then hit policy, columns and rules. Ids, whitespace and layout are
 * ignored, and so is rule order wherever `ruleOrderMatters` says it cannot change a result. Decision order is
 * ignored; required decisions are compared by name.
 */
export function diffDocuments(file: string, a: DmnDocument, b: DmnDocument, options: DiffOptions = {}): Difference[] {
  const out: Difference[] = [];
  const nameById = (doc: DmnDocument) => new Map(doc.decisions.map((d) => [d.id, d.name]));
  const na = nameById(a);
  const nb = nameById(b);
  const byName = (doc: DmnDocument) => new Map(doc.decisions.map((d) => [d.name, d]));
  const da = byName(a);
  const db = byName(b);
  for (const [name, decision] of da) {
    const other = db.get(name);
    if (!other) {
      out.push({ file, decision: name, message: "decision only in first" });
      continue;
    }
    const required = (d: DmnDecision, names: Map<string, string>) => d.requires.map((id) => names.get(id) ?? id).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    if (JSON.stringify(required(decision, na)) !== JSON.stringify(required(other, nb))) {
      out.push({ file, decision: name, message: `requires differ: ${required(decision, na).join(", ")} vs ${required(other, nb).join(", ")}` });
    }
    diffDecision(file, decision, other, options, out);
  }
  for (const name of db.keys()) {
    if (!da.has(name)) {
      out.push({ file, decision: name, message: "decision only in second" });
    }
  }
  return out;
}

const dmnFiles = (dir: string): string[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".dmn"))
    .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

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
    out.push(
      ...diffDocuments(
        nameA as string,
        parseDmn(readFileSync(join(a.dir, nameA as string), "utf8")),
        parseDmn(readFileSync(join(b.dir, nameB as string), "utf8")),
        options
      )
    );
  }
  return out;
}

export function renderDifferences(differences: Difference[]): string {
  return differences.map((d) => `${d.file}${d.decision ? ` [${d.decision}]` : ""}: ${d.message}`).join("\n");
}
