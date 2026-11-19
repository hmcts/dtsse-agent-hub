/** One element of a sequence merged across case types, and the case types that have it. */
export interface Merged<T> {
  item: T;
  caseTypes: string[];
}

/**
 * Folds one case type's sequence into the merged one as a shortest common supersequence, so every case type's own
 * order stays a subsequence of the result. Items with the same identity are shared; the rest are kept apart.
 */
export function mergeSequences<T>(merged: Array<Merged<T>>, caseType: string, items: T[], identity: (item: T) => string): Array<Merged<T>> {
  const a = merged.map((m) => identity(m.item));
  const b = items.map(identity);
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      row[j] = a[i] === b[j] ? ((lcs[i + 1] as number[])[j + 1] as number) + 1 : Math.max((lcs[i + 1] as number[])[j] as number, row[j + 1] as number);
    }
  }
  const out: Array<Merged<T>> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      const shared = merged[i] as Merged<T>;
      out.push({ item: shared.item, caseTypes: [...shared.caseTypes, caseType] });
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && ((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number))) {
      out.push(merged[i] as Merged<T>);
      i++;
    } else {
      out.push({ item: items[j] as T, caseTypes: [caseType] });
      j++;
    }
  }
  return out;
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
