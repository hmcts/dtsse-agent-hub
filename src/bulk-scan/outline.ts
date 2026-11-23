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
  return field.todo.length > 0 || (field.review ?? []).length > 0;
}

/** How many fields want a person: those with an open marker or TODO, and those the last save refused. */
export function reviewTotal(spec: FormSpec, refused: ReadonlyMap<string, unknown> = new Map()): number {
  return spec.sections.reduce((sum, section, s) => sum + section.fields.filter((field, f) => needsReview(field) || refused.has(`${s}.${f}`)).length, 0);
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

/** The choices for whether a field is mandatory, with the words the select and the outline's badge both show. */
export const MANDATORY_CHOICES: readonly { value: Field["mandatory"]; label: string }[] = [
  { value: "mandatory", label: "Mandatory" },
  { value: "optional", label: "Optional" },
  { value: "conditional", label: "Mandatory if…" },
  { value: "not-read", label: "Not read" }
];

export function mandatoryLabel(mandatory: Field["mandatory"]): string {
  return MANDATORY_CHOICES.find((choice) => choice.value === mandatory)?.label ?? mandatory;
}

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

/** What keeps a section and its fields the same across edits, which rebuild the objects: a key for each. */
export interface Identity {
  key: string;
  fields: string[];
}

export function identitiesOf(spec: FormSpec, fresh: () => string): Identity[] {
  return spec.sections.map((section) => ({ key: fresh(), fields: section.fields.map(fresh) }));
}

/**
 * The identities after `prev` became `next`. A section or field that is the same object keeps its key wherever it
 * went; one that was replaced in place (an edit rebuilds the object) takes the key of the one it replaced; one that is
 * new gets a fresh key, and a removed one's key is dropped.
 */
export function reconcileIdentities(prev: FormSpec, next: FormSpec, ids: readonly Identity[], fresh: () => string): Identity[] {
  const sectionAt = new Map(prev.sections.map((section, i) => [section, i]));
  const fieldKey = new Map(prev.sections.flatMap((section, s) => section.fields.map((field, f): [Field, string] => [field, ids[s]?.fields[f] ?? ""])));
  const kept = new Set(next.sections.flatMap((section) => section.fields));
  return next.sections.map((section, j) => {
    const same = sectionAt.get(section);
    const replaced = same === undefined && !next.sections.includes(prev.sections[j] as never) ? j : undefined;
    const from = same ?? replaced;
    const before = from === undefined ? undefined : prev.sections[from];
    return {
      key: (from === undefined ? undefined : ids[from]?.key) ?? fresh(),
      fields: section.fields.map((field, f) => {
        const own = fieldKey.get(field);
        if (own) {
          return own;
        }
        const old = before?.fields[f];
        return old && !kept.has(old) ? (fieldKey.get(old) ?? fresh()) : fresh();
      })
    };
  });
}
