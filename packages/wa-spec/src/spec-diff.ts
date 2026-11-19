import type { Spec } from "./schema.ts";

const MAX_DIFFERENCES = 40;

/**
 * Differences between two specs, compared as data: object keys in any order, arrays in order, because the order of rows
 * and of values in an entry is what a COLLECT or RULE ORDER table returns in. Empty when they are equal.
 */
export function diffSpecs(a: Spec, b: Spec): string[] {
  const out: string[] = [];
  walk(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), "spec", out);
  return out;
}

function walk(a: unknown, b: unknown, path: string, out: string[]): void {
  if (out.length >= MAX_DIFFERENCES) {
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(`${path}: ${a.length} items vs ${b.length}`);
    }
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      walk(a[i], b[i], `${path}[${i}]`, out);
    }
    return;
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (!(key in right)) {
        out.push(`${path}.${key}: only in the first`);
      } else if (!(key in left)) {
        out.push(`${path}.${key}: only in the second`);
      } else {
        walk(left[key], right[key], `${path}.${key}`, out);
      }
    }
    return;
  }
  if (a !== b) {
    out.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
}
