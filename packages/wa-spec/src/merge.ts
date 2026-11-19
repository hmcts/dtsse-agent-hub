/** One element of a sequence merged across case types, and the case types that have it. */
export interface Merged<T> {
  item: T;
  caseTypes: string[];
}

export type AlignStep = { op: "keep"; a: number; b: number } | { op: "del"; a: number } | { op: "add"; b: number };

/** Aligns two sequences by longest common subsequence: what both have, what only `a` has and what only `b` has, in order. */
export function align(a: string[], b: string[]): AlignStep[] {
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  const at = (i: number, j: number): number => (lcs[i] as number[])[j] as number;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      (lcs[i] as number[])[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const steps: AlignStep[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      steps.push({ op: "keep", a: i++, b: j++ });
    } else if (j >= b.length || (i < a.length && at(i + 1, j) >= at(i, j + 1))) {
      steps.push({ op: "del", a: i++ });
    } else {
      steps.push({ op: "add", b: j++ });
    }
  }
  return steps;
}

/**
 * Folds one case type's sequence into the merged one as a shortest common supersequence, so every case type's own
 * order stays a subsequence of the result. Items with the same identity are shared; the rest are kept apart.
 */
export function mergeSequences<T>(merged: Array<Merged<T>>, caseType: string, items: T[], identity: (item: T) => string): Array<Merged<T>> {
  return align(
    merged.map((m) => identity(m.item)),
    items.map(identity)
  ).map((step) => {
    if (step.op === "keep") {
      const shared = merged[step.a] as Merged<T>;
      return { item: shared.item, caseTypes: [...shared.caseTypes, caseType] };
    }
    return step.op === "del" ? (merged[step.a] as Merged<T>) : { item: items[step.b] as T, caseTypes: [caseType] };
  });
}

/** The most common value among the case types that have it; the first seen wins a tie. */
export function majority<T>(
  values: Array<{ caseType: string; value: T }>,
  key: (value: T) => string = (v) => JSON.stringify(v) ?? "undefined"
): {
  base: T;
  differing: Array<{ caseType: string; value: T }>;
} {
  const counts = new Map<string, number>();
  for (const { value } of values) {
    counts.set(key(value), (counts.get(key(value)) ?? 0) + 1);
  }
  let best = values[0] as { caseType: string; value: T };
  for (const entry of values) {
    if ((counts.get(key(entry.value)) ?? 0) > (counts.get(key(best.value)) ?? 0)) {
      best = entry;
    }
  }
  return { base: best.value, differing: values.filter((v) => key(v.value) !== key(best.value)) };
}
