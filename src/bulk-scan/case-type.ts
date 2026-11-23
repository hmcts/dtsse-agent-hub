import type { CcdConfig, Field, FormSpec } from "@hmcts-cft/bulk-scan-spec";
import { type CcdField, matchCcd, newCcdFields } from "@hmcts-cft/bulk-scan-spec/ccd-match";
import { byCode } from "@hmcts-cft/bulk-scan-spec/compare";

export { NEW_FIELD_TYPES } from "@hmcts-cft/bulk-scan-spec/ccd-match";

/**
 * The editor's changes to which case type a form maps into and how each field stands against it, as pure functions on the
 * spec. Browser-safe, like `edit.ts`: matching is the spec package's `ccd-match` module, which has no dependency on the
 * engine or the importers.
 */

export interface CaseTypeChoice {
  product: string;
  caseType: string;
  config?: CcdConfig | null;
}

export interface CaseTypeOptions {
  /** Map only the rows that carry an id; by default, unless the form came from a PDF: a sheet's unmapped rows are deliberate, and a form saved before its source was recorded is read as a sheet. */
  onlyMapped?: boolean;
}

/** The form header set to a case type, with its fields' ids kept to check a typed id against. */
export function withCaseTypeHeader(spec: FormSpec, choice: CaseTypeChoice, fields: readonly Pick<CcdField, "id">[]): FormSpec {
  const { ccdConfig: _config, ...form } = spec.form;
  const ccdFieldIds = [...new Set(fields.map((f) => f.id))].sort(byCode);
  return {
    ...spec,
    form: { ...form, ccdCaseTypeId: choice.caseType, ccdProduct: choice.product, ccdFieldIds, ...(choice.config ? { ccdConfig: choice.config } : {}) }
  };
}

/** The fields without the review entries about CCD ids, which an earlier case type's match left. */
function withoutCcdReviews(spec: FormSpec): FormSpec {
  return {
    ...spec,
    sections: spec.sections.map((section) => ({
      ...section,
      fields: section.fields.map(({ review, ...field }) => {
        const kept = (review ?? []).filter((r) => r.about !== "ccd");
        return kept.length > 0 ? { ...field, review: kept } : field;
      })
    }))
  };
}

/** The spec set to a case type, and matched against its fields. The ids a person set or chose, and those that came with the form, stay; only their status is refreshed. */
export function withCaseType(spec: FormSpec, choice: CaseTypeChoice, fields: CcdField[], options: CaseTypeOptions = {}): FormSpec {
  return matchCcd(withoutCcdReviews(withCaseTypeHeader(spec, choice, fields)), fields, {
    keepSet: true,
    onlyMapped: options.onlyMapped ?? spec.form.source !== "pdf"
  });
}

/** The spec with no case type: its fields lose their status and the ids the matcher proposed, and keep the ids a person set or chose and those that came with the form. */
export function withoutCaseType(spec: FormSpec): FormSpec {
  const { ccdCaseTypeId: _id, ccdProduct: _product, ccdConfig: _config, ccdFieldIds: _ids, ...form } = spec.form;
  return withoutCcdReviews({
    ...spec,
    form,
    sections: spec.sections.map((section) => ({
      ...section,
      fields: section.fields.map(({ ccdMatch, ...field }) => (ccdMatch !== undefined && ccdMatch.chosenBy === undefined ? { ...field, ccd: [] } : field))
    }))
  });
}

/**
 * The rows that go with the one at `fieldIndex`: those of its section that the matcher decided together (the lines of
 * an address) and that share its proposal, so a row with an id of its own is edited alone.
 */
function groupOf(fields: readonly Field[], fieldIndex: number): number[] {
  const own = fields[fieldIndex]?.ccdMatch;
  if (own?.group === undefined) {
    return [fieldIndex];
  }
  return fields.flatMap((f, i) => (f.ccdMatch?.group === own.group && f.ccdMatch?.newField?.id === own.newField?.id ? [i] : []));
}

function mapGroup(spec: FormSpec, sectionIndex: number, fieldIndex: number, change: (field: Field) => Field): FormSpec {
  const members = new Set(groupOf(spec.sections[sectionIndex]?.fields ?? [], fieldIndex));
  return {
    ...spec,
    sections: spec.sections.map((section, s) =>
      s !== sectionIndex ? section : { ...section, fields: section.fields.map((f, i) => (members.has(i) ? change(f) : f)) }
    )
  };
}

/** An unsure row decided as one of its candidates, which is then an existing field. */
export function chooseCandidate(spec: FormSpec, sectionIndex: number, fieldIndex: number, id: string): FormSpec {
  return mapGroup(spec, sectionIndex, fieldIndex, (field) => ({ ...field, ccd: [id], ccdMatch: { status: "existing", chosenBy: "person" } }));
}

/** An unsure row decided as a new field, with the id and type proposed for it. */
export function chooseNew(spec: FormSpec, sectionIndex: number, fieldIndex: number): FormSpec {
  return mapGroup(spec, sectionIndex, fieldIndex, (field) => {
    const proposed = field.ccdMatch?.newField;
    return proposed ? { ...field, ccd: [proposed.id], ccdMatch: { status: "new", newField: proposed, chosenBy: "person" } } : field;
  });
}

/** A new field's id or CCD FieldType changed; the id is also what its rows write to. */
export function editNewField(spec: FormSpec, sectionIndex: number, fieldIndex: number, patch: { id?: string; type?: string }): FormSpec {
  return mapGroup(spec, sectionIndex, fieldIndex, (field) => {
    const current = field.ccdMatch?.newField;
    if (field.ccdMatch?.status !== "new" || !current) {
      return field;
    }
    const next = { id: patch.id ?? current.id, type: patch.type ?? current.type };
    if (spec.form.ccdFieldIds?.includes(next.id)) {
      return {
        ...field,
        ccd: [next.id],
        ccdMatch: { status: "existing", chosenBy: "person", ...(field.ccdMatch.group ? { group: field.ccdMatch.group } : {}) }
      };
    }
    return { ...field, ccd: [next.id], ccdMatch: { ...field.ccdMatch, newField: next, chosenBy: "person" } };
  });
}

/** What the header counts: the case fields to add, and the rows still to choose. */
export function ccdCounts(spec: FormSpec): { newFields: number; unsure: number } {
  const unsure = new Set(
    spec.sections.flatMap((s) => s.fields.flatMap((f) => (f.ccdMatch?.status === "unsure" && f.ccdMatch.newField ? [f.ccdMatch.newField.id] : [])))
  );
  return { newFields: newCcdFields(spec).length, unsure: unsure.size };
}
