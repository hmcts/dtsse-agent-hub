import type { Spec } from "./schema.ts";

const MAX_DIFFERENCES = 40;

/**
 * Differences between two specs, compared as data: object keys in any order, arrays in order, because the order of rows
 * and of values in an entry is what a COLLECT or RULE ORDER table returns in. `differences` holds the first
 * MAX_DIFFERENCES; `total` counts them all. Both are empty or zero when the specs are equal.
 */
export function compareSpecs(a: Spec, b: Spec): { differences: string[]; total: number } {
  const found = { differences: [] as string[], total: 0 };
  walk(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), "spec", found);
  return found;
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
