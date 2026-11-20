import type { CodeKey } from "./code-keys.ts";
import { byCode } from "./compare.ts";
import { keyConflicts } from "./emits.ts";
import type { FormSpec } from "./schema.ts";
import { allFields } from "./schema.ts";

export interface SpecKey {
  key: string;
  /** False for keys on rows the sheet marks "Do not read", which Exela never emits. */
  readable: boolean;
  /** Sheet ids of every row the key appears on. */
  ids: string[];
}

export interface DriftMatch {
  key: string;
  codeKey: string;
}

export interface SheetInternal {
  key: string;
  /** "description-only": the Description column emits it but the Tag Name column does not list it; "tag-only": the reverse. */
  side: "description-only" | "tag-only";
  ids: string[];
  /** How the key stands against the service code. */
  code: "exact" | "case-only" | "none";
}

export interface DriftReport {
  /** Keys on which the sheet's own Description and Tag Name columns disagree, with whether the code uses them. */
  sheetInternal: SheetInternal[];
  /** Code-only keys that the sheet does describe, on a row whose Tag Name column names something else. */
  codeOnlyExplained: { key: string; ids: string[] }[];
  exact: DriftMatch[];
  caseOnly: DriftMatch[];
  likelyRenamed: (DriftMatch & { score: number })[];
  specOnly: SpecKey[];
  codeOnly: string[];
  /** Spec keys that appear on more than one row. */
  duplicates: SpecKey[];
  /** Exact matches that reach the code through a @JsonProperty alias rather than the field name. */
  viaAlias: DriftMatch[];
}

export const RENAME_THRESHOLD = 0.6;

export function specKeys(spec: FormSpec): SpecKey[] {
  const byKey = new Map<string, SpecKey>();
  allFields(spec).forEach((field, index) => {
    for (const key of field.keys) {
      const entry = byKey.get(key) ?? { key, readable: field.mandatory !== "not-read", ids: [] };
      entry.readable ||= field.mandatory !== "not-read";
      entry.ids.push(field.id ?? `field ${index + 1}`);
      byKey.set(key, entry);
    }
  });
  return [...byKey.values()];
}

function tokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t));
}

/** Overlap of the words in two keys, ignoring case and a trailing plural s. */
export function similarity(a: string, b: string): number {
  const x = new Set(tokens(a));
  const y = new Set(tokens(b));
  const shared = [...x].filter((t) => y.has(t)).length;
  const union = new Set([...x, ...y]).size;
  return union === 0 ? 0 : shared / union;
}

export function sheetInternalKeys(spec: FormSpec): Omit<SheetInternal, "code">[] {
  const out: Omit<SheetInternal, "code">[] = [];
  allFields(spec).forEach((field, index) => {
    const { descriptionOnly, tagOnly } = keyConflicts(field);
    const id = field.id ?? `field ${index + 1}`;
    for (const key of descriptionOnly) {
      out.push({ key, side: "description-only", ids: [id] });
    }
    for (const key of tagOnly) {
      out.push({ key, side: "tag-only", ids: [id] });
    }
  });
  return out;
}

export function classifyDrift(spec: SpecKey[], codeInput: CodeKey[], internal: Omit<SheetInternal, "code">[] = []): DriftReport {
  const code = [...new Map(codeInput.map((c) => [c.key, c])).values()];
  const codeByKey = new Map(code.map((c) => [c.key, c]));
  const exact: DriftMatch[] = [];
  const viaAlias: DriftMatch[] = [];
  const unmatchedSpec: SpecKey[] = [];
  const claimed = new Set<string>();

  for (const s of spec) {
    const hit = codeByKey.get(s.key);
    if (hit) {
      exact.push({ key: s.key, codeKey: hit.key });
      if (hit.alias) {
        viaAlias.push({ key: s.key, codeKey: hit.alias.field });
      }
      claimed.add(hit.key);
    } else {
      unmatchedSpec.push(s);
    }
  }

  const caseOnly: DriftMatch[] = [];
  const stillUnmatched: SpecKey[] = [];
  for (const s of unmatchedSpec) {
    const candidates = code.filter((c) => !claimed.has(c.key) && c.key.toLowerCase() === s.key.toLowerCase());
    const [first] = candidates;
    if (candidates.length === 1 && first) {
      caseOnly.push({ key: s.key, codeKey: first.key });
      claimed.add(first.key);
    } else {
      stillUnmatched.push(s);
    }
  }

  const pairs: { spec: SpecKey; code: string; score: number }[] = [];
  for (const s of stillUnmatched) {
    for (const c of code) {
      if (claimed.has(c.key)) {
        continue;
      }
      const score = similarity(s.key, c.key);
      if (score >= RENAME_THRESHOLD) {
        pairs.push({ spec: s, code: c.key, score });
      }
    }
  }
  pairs.sort((a, b) => b.score - a.score || byCode(a.spec.key, b.spec.key));
  const likelyRenamed: DriftReport["likelyRenamed"] = [];
  const renamedSpec = new Set<string>();
  for (const p of pairs) {
    if (renamedSpec.has(p.spec.key) || claimed.has(p.code)) {
      continue;
    }
    renamedSpec.add(p.spec.key);
    claimed.add(p.code);
    likelyRenamed.push({ key: p.spec.key, codeKey: p.code, score: Math.round(p.score * 100) / 100 });
  }

  const codeKeys = new Set(code.map((c) => c.key));
  const codeLower = new Set(code.map((c) => c.key.toLowerCase()));
  const sheetInternal = internal.map((i) => ({
    ...i,
    code: codeKeys.has(i.key) ? ("exact" as const) : codeLower.has(i.key.toLowerCase()) ? ("case-only" as const) : ("none" as const)
  }));
  const codeOnly = code.map((c) => c.key).filter((k) => !claimed.has(k));
  return {
    sheetInternal,
    codeOnlyExplained: codeOnly.flatMap((k) => {
      const hits = internal.filter((i) => i.key === k && i.side === "description-only");
      return hits.length > 0 ? [{ key: k, ids: hits.flatMap((h) => h.ids) }] : [];
    }),
    exact,
    caseOnly,
    likelyRenamed,
    specOnly: stillUnmatched.filter((s) => !renamedSpec.has(s.key)),
    codeOnly,
    duplicates: spec.filter((s) => s.ids.length > 1),
    viaAlias
  };
}

export function formatDrift(report: DriftReport, labels: { spec: string; code: string }): string {
  const lines: string[] = [];
  const total = report.exact.length + report.caseOnly.length + report.likelyRenamed.length + report.specOnly.length;
  lines.push(`${labels.spec} (${total} distinct keys) vs ${labels.code}`);
  lines.push(
    `  exact ${report.exact.length} (${report.viaAlias.length} via @JsonProperty), case-only ${report.caseOnly.length}, likely-renamed ${report.likelyRenamed.length}, spec-only ${report.specOnly.length}, code-only ${report.codeOnly.length}`
  );
  for (const m of report.viaAlias) {
    lines.push(`  via alias   ${m.key} (field ${m.codeKey})`);
  }
  for (const m of report.caseOnly) {
    lines.push(`  case-only   ${m.key} -> ${m.codeKey}`);
  }
  for (const m of report.likelyRenamed) {
    lines.push(`  renamed     ${m.key} -> ${m.codeKey} (${m.score})`);
  }
  for (const s of report.specOnly) {
    lines.push(`  spec-only   ${s.key} (rows ${s.ids.join(", ")})${s.readable ? "" : " [sheet marks the row 'Do not read']"}`);
  }
  for (const k of report.codeOnly) {
    lines.push(`  code-only   ${k}`);
  }
  for (const s of report.sheetInternal) {
    lines.push(`  sheet-internal ${s.key} ${s.side} on ${s.ids.join(", ")}; service code: ${s.code}`);
  }
  for (const e of report.codeOnlyExplained) {
    lines.push(`  code-only ${e.key} is described in the sheet (row ${e.ids.join(", ")}) but not in its Tag Name column`);
  }
  for (const d of report.duplicates) {
    lines.push(`  duplicate   ${d.key} on rows ${d.ids.join(", ")}`);
  }
  return lines.join("\n");
}
