import { byCodePoint } from "./merge.ts";
import { stable } from "./model-compile.ts";
import type { Spec } from "./schema.ts";

const MAX_DIFFERENCES = 40;

/**
 * Differences between two specs, compared as data: object keys in any order, arrays in order, because the order of rows
 * and of values in an entry is what a COLLECT or RULE ORDER table returns in. `differences` holds the first
 * MAX_DIFFERENCES; `total` counts them all. Both are empty or zero when the specs are equal.
 */
export function compareSpecs(a: Spec, b: Spec, options: { ignoreRuleOrder?: boolean } = {}): { differences: string[]; total: number } {
  const found = { differences: [] as string[], total: 0 };
  const plain = (spec: Spec): Spec => (options.ignoreRuleOrder ? withRowsAsSets(spec) : JSON.parse(JSON.stringify(spec)));
  walk(plain(a), plain(b), "spec", found);
  return found;
}

/** The spec with each table's rows in a fixed order, so tables with the same rows in any order compare equal. */
function withRowsAsSets(spec: Spec): Spec {
  const copy: Spec = JSON.parse(JSON.stringify(spec));
  for (const decision of Object.values(copy.decisions)) {
    if (decision) {
      decision.rows = decision.rows
        .map((row) => ({ key: stable(row), row }))
        .sort((x, y) => byCodePoint(x.key, y.key))
        .map((x) => x.row);
    }
  }
  return copy;
}

export const diffSpecs = (a: Spec, b: Spec): string[] => compareSpecs(a, b).differences;

type Found = { differences: string[]; total: number };

function report(found: Found, message: string): void {
  found.total++;
  if (found.differences.length < MAX_DIFFERENCES) {
    found.differences.push(message);
  }
}

function walk(a: unknown, b: unknown, path: string, found: Found): void {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      report(found, `${path}: ${a.length} items vs ${b.length}`);
    }
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      walk(a[i], b[i], `${path}[${i}]`, found);
    }
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
