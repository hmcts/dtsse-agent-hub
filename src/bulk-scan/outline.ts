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
  return field.id || field.keys[0] || field.label || `field ${index + 1}`;
}

export type Badge = "mandatory" | "optional" | "conditional" | "not-read";

export const BADGE_WORDS: Record<Badge, string> = {
  mandatory: "Mandatory",
  optional: "Optional",
  conditional: "Conditional",
  "not-read": "Not read"
};
