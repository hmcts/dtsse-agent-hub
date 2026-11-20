import type { Field, FormSpec } from "@hmcts-cft/bulk-scan-spec";

/**
 * The editor's changes to a spec, as pure functions on it. Only types come from the spec package: this runs in the
 * browser, which must not load the engine.
 */

/** The form-level values the editor changes. */
export type HeaderPatch = Partial<Pick<FormSpec["form"], "name" | "formType" | "poBox">>;

export function patchHeader(spec: FormSpec, patch: HeaderPatch): FormSpec {
  const form = { ...spec.form };
  for (const [name, value] of Object.entries(patch) as [keyof HeaderPatch, string][]) {
    if (value === "" && name !== "name" && name !== "formType") {
      delete form[name];
    } else {
      form[name] = value;
    }
  }
  return { ...spec, form };
}

/** The field values the editor changes. */
export type FieldPatch = Partial<Pick<Field, "id" | "label" | "keys" | "ccd" | "inputType" | "mandatory" | "regex" | "maxLength">>;

/** The spec with one field replaced. An empty id, regex or maximum length is the field without one. */
export function patchField(spec: FormSpec, sectionIndex: number, fieldIndex: number, patch: FieldPatch): FormSpec {
  return {
    ...spec,
    sections: spec.sections.map((section, s) =>
      s !== sectionIndex
        ? section
        : {
            ...section,
            fields: section.fields.map((field, f) => {
              if (f !== fieldIndex) {
                return field;
              }
              const next: Field = { ...field, ...patch };
              for (const optional of ["id", "regex", "maxLength"] as const) {
                if (next[optional] === "" || next[optional] === undefined) {
                  delete next[optional];
                }
              }
              return next;
            })
          }
    )
  };
}

/** A list the editor shows as one line of words: keys and CCD ids are separated by spaces, commas or new lines. */
export function wordsOf(text: string): string[] {
  return text.split(/[\s,]+/).filter((word) => word !== "");
}

/** A maximum length typed as digits: a whole number, or none for an empty box. */
export function maxLengthOf(digits: string): number | undefined {
  return digits === "" ? undefined : Number(digits);
}

/** The rows a saved spec's issues belong to, by `section.field`, and the ones about the form as a whole. */
export function issuesByField(issues: readonly { path: string; message: string }[]): { fields: Map<string, string[]>; form: string[] } {
  const fields = new Map<string, string[]>();
  const form: string[] = [];
  for (const { path, message } of issues) {
    const match = /^sections\.(\d+)\.fields\.(\d+)(?:\.(.+))?$/.exec(path);
    if (!match) {
      form.push(path === "" ? message : `${path}: ${message}`);
      continue;
    }
    const at = `${match[1]}.${match[2]}`;
    fields.set(at, [...(fields.get(at) ?? []), match[3] ? `${match[3]}: ${message}` : message]);
  }
  return { fields, form };
}

export interface ReviewLine {
  /** `section.field` index. */
  at: string;
  where: string;
  about: string;
  reason: string;
  confidence: "low" | "medium" | "high";
}

const RANK = { low: 0, medium: 1, high: 2 } as const;

/** Every guess a PDF's draft marked for a person to confirm, lowest confidence first. */
export function reviewChecklist(spec: FormSpec): ReviewLine[] {
  const lines = spec.sections.flatMap((section, s) =>
    section.fields.flatMap((field, f) =>
      (field.review ?? []).map((r) => ({
        at: `${s}.${f}`,
        where: [field.id, field.label].filter(Boolean).join(" ") || field.keys[0] || "field",
        about: r.about,
        reason: r.reason,
        confidence: r.confidence
      }))
    )
  );
  return lines.sort((a, b) => RANK[a.confidence] - RANK[b.confidence]);
}
