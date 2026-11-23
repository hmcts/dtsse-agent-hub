import type { Field, FormSpec } from "@hmcts-cft/bulk-scan-spec";

/** What the outline shows of a field beside its name: how many open markers it has, and whether English is still unparsed. */
export interface FieldFlags {
  review: number;
  todo: number;
  /** The sheet's logic is still text, or a branch holds English the importer could not read. */
  english: boolean;
}

export function fieldFlags(field: Field): FieldFlags {
  return {
    review: (field.review ?? []).length,
    todo: field.todo.length,
    english: Boolean(field.logicText) || field.rules.some((rule) => Boolean(rule.action))
  };
}

/** A field needs review while it has a review marker or a TODO that nobody has marked done. */
export function needsReview(field: Field): boolean {
  const { review, todo } = fieldFlags(field);
  return review + todo > 0;
}

export function reviewTotal(spec: FormSpec): number {
  return spec.sections.reduce((sum, section) => sum + section.fields.filter(needsReview).length, 0);
}

/** The words a field is found by: its id, label, keys and CCD ids. */
export function matchesQuery(field: Field, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle === "" || [field.id ?? "", field.label, ...field.keys, ...field.ccd].some((text) => text.toLowerCase().includes(needle));
}

/** What a field is called in the editor: its id, else its first key, else its label. */
export function fieldName(field: Field, index: number): string {
  return field.id || field.keys[0] || field.label.split("\n")[0]?.trim() || `field ${index + 1}`;
}

export type Badge = "mandatory" | "optional" | "conditional" | "not-read";

export const BADGE_WORDS: Record<Badge, string> = {
  mandatory: "Mandatory",
  optional: "Optional",
  conditional: "Conditional",
  "not-read": "Not read"
};

const RANK = { low: 0, medium: 1, high: 2 } as const;

/** How soon a field wants a person: 0 for a TODO or a low-confidence marker, up to 2 for a high one, 3 when nothing is open. */
export function reviewRank(field: Field): number {
  const ranks = [...(field.todo.length > 0 ? [0] : []), ...(field.review ?? []).map((r) => RANK[r.confidence])];
  return ranks.length > 0 ? Math.min(...ranks) : 3;
}

export interface Selection {
  section: number;
  field: number | null;
}

/** The open item after section `s` moves by `by`: the same item wherever it went. */
export function afterSectionMove(selection: Selection | null, s: number, by: -1 | 1): Selection | null {
  if (!selection) {
    return null;
  }
  const section = selection.section === s ? s + by : selection.section === s + by ? s : selection.section;
  return { section, field: selection.field };
}

/** The open item after section `s` is removed from `count` sections: the same item, or the section beside it when it was in the removed one. */
export function afterSectionRemove(selection: Selection | null, s: number, count: number): Selection | null {
  if (!selection || count <= 1) {
    return null;
  }
  if (selection.section === s) {
    return { section: Math.min(s, count - 2), field: null };
  }
  return { section: selection.section > s ? selection.section - 1 : selection.section, field: selection.field };
}
