import { ruleOrderMatters } from "./diff.ts";
import { align, byCodePoint } from "./merge.ts";
import { stable } from "./model-compile.ts";
import { KINDS, type Kind, type Spec } from "./schema.ts";

const MAX_DIFFERENCES = 40;

export interface CompareOptions {
  /** Compare every table's rows as a set, whatever its hit policy. */
  ignoreRuleOrder?: boolean;
  /** Compare row order everywhere, which is what a lift's own check needs. */
  strict?: boolean;
}

/**
 * Differences between two specs, compared as data: object keys in any order, arrays in order. A table's rows are compared
 * as a set where its hit policy makes their order irrelevant (as the DMN diff does), or always with `ignoreRuleOrder`,
 * and in order everywhere with `strict`. `differences` holds the first MAX_DIFFERENCES; `total` counts them all.
 */
export function compareSpecs(a: Spec, b: Spec, options: CompareOptions = {}): { differences: string[]; total: number } {
  const found = { differences: [] as string[], total: 0 };
  const matters = (spec: Spec, kind: Kind): boolean => {
    const decision = spec.decisions[kind];
    const all = [decision, ...Object.values(decision?.overrides ?? {})];
    return all.some(
      (d) =>
        d &&
        ruleOrderMatters(d.hitPolicy ?? decision?.hitPolicy ?? "COLLECT", d.aggregation === undefined ? decision?.aggregation : (d.aggregation ?? undefined))
    );
  };
  const relaxed = new Set(KINDS.filter((kind) => !options.strict && (options.ignoreRuleOrder || !(matters(a, kind) || matters(b, kind)))));
  walk(withRows(a, relaxed), withRows(b, relaxed), "spec", found);
  return found;
}

/** A copy of the spec with the rows of the given tables in a fixed order, so tables with the same rows in any order compare equal. */
function withRows(spec: Spec, asSets: Set<Kind>): Spec {
  const copy: Spec = JSON.parse(JSON.stringify(spec));
  for (const kind of asSets) {
    const decision = copy.decisions[kind];
    if (decision) {
      decision.rows = decision.rows
        .map((row) => ({ key: stable(row), row }))
        .sort((x, y) => byCodePoint(x.key, y.key))
        .map((x) => x.row);
    }
  }
  return copy;
}

/** Strict: every table's rows in order. */
export const diffSpecs = (a: Spec, b: Spec): string[] => compareSpecs(a, b, { strict: true }).differences;

type Found = { differences: string[]; total: number };

function report(found: Found, message: string): void {
  found.total++;
  if (found.differences.length < MAX_DIFFERENCES) {
    found.differences.push(message);
  }
}

function walk(a: unknown, b: unknown, path: string, found: Found): void {
  if (Array.isArray(a) && Array.isArray(b)) {
    walkArrays(a, b, path, found);
    return;
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (!(key in right)) {
        report(found, `${path}.${key}: only in the first`);
      } else if (!(key in left)) {
        report(found, `${path}.${key}: only in the second`);
      } else {
        walk(left[key], right[key], `${path}.${key}`, found);
      }
    }
    return;
  }
  if (a !== b) {
    report(found, `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
}

const ALIGN_LIMIT = 4_000_000;
const preview = (value: unknown): string => {
  const text = JSON.stringify(value);
  return text.length > 100 ? `${text.slice(0, 100)}...` : text;
};

/**
 * Arrays of equal length are compared item by item. Otherwise they are aligned on equal items, so one inserted or removed
 * row is reported as that and not as every row after it differing; a removed run and an inserted run of one length are
 * compared in pairs, as edits.
 */
function walkArrays(a: unknown[], b: unknown[], path: string, found: Found): void {
  if (a.length === b.length || a.length * b.length > ALIGN_LIMIT) {
    if (a.length !== b.length) {
      report(found, `${path}: ${a.length} items vs ${b.length}`);
    }
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      walk(a[i], b[i], `${path}[${i}]`, found);
    }
    return;
  }
  let removed: number[] = [];
  let inserted: number[] = [];
  const flush = () => {
    const paired = Math.min(removed.length, inserted.length);
    for (let k = 0; k < paired; k++) {
      walk(a[removed[k] as number], b[inserted[k] as number], `${path}[${removed[k]}]`, found);
    }
    for (const i of removed.slice(paired)) {
      report(found, `${path}[${i}]: removed ${preview(a[i])}`);
    }
    for (const j of inserted.slice(paired)) {
      report(found, `${path}[${j}]: inserted ${preview(b[j])}`);
    }
    removed = [];
    inserted = [];
  };
  for (const step of align(a.map(stable), b.map(stable))) {
    if (step.op === "keep") {
      flush();
    } else if (step.op === "del") {
      removed.push(step.a);
    } else {
      inserted.push(step.b);
    }
  }
  flush();
}
