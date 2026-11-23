import type { Field, FormSpec } from "@hmcts-cft/bulk-scan-spec";
import { type CcdField, matchCcd, newCcdFields } from "@hmcts-cft/bulk-scan-spec/ccd-match";

/**
 * The editor's changes to which case type a form maps into and how each field stands against it, as pure functions on the
 * spec. Browser-safe, like `edit.ts`: matching is the spec package's `ccd-match` module, which has no dependency on the
 * engine or the importers.
 */

export interface CaseTypeChoice {
  product: string;
  caseType: string;
  config?: "config-generator" | "json" | "hybrid" | null;
}

/** The spec set to a case type, and matched against its fields. The ids a person already set stay; only their status is refreshed. */
export function withCaseType(spec: FormSpec, choice: CaseTypeChoice, fields: CcdField[]): FormSpec {
  const { ccdConfig: _config, ...form } = spec.form;
  const header = { ...form, ccdCaseTypeId: choice.caseType, ccdProduct: choice.product, ...(choice.config ? { ccdConfig: choice.config } : {}) };
  return matchCcd({ ...spec, form: header }, fields, { keepSet: true });
}

/** The spec with no case type: its fields keep their ids and lose their status. */
export function withoutCaseType(spec: FormSpec): FormSpec {
  const { ccdCaseTypeId: _id, ccdProduct: _product, ccdConfig: _config, ...form } = spec.form;
  return {
    ...spec,
    form,
    sections: spec.sections.map((section) => ({
      ...section,
      fields: section.fields.map(({ ccdMatch: _match, ...field }) => field)
    }))
  };
}

/**
 * The rows that go with the one at `fieldIndex`: the rows next to it, in its section, that carry the same case field
 * decision, as the lines of an address do.
 */
function groupOf(fields: readonly Field[], fieldIndex: number): number[] {
  const key = (f: Field | undefined): string | undefined => (f?.ccdMatch ? JSON.stringify(f.ccdMatch) : undefined);
  const wanted = key(fields[fieldIndex]);
  if (wanted === undefined) {
    return [fieldIndex];
  }
  let from = fieldIndex;
  let to = fieldIndex;
  while (key(fields[from - 1]) === wanted) {
    from--;
  }
  while (key(fields[to + 1]) === wanted) {
    to++;
  }
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
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
  return mapGroup(spec, sectionIndex, fieldIndex, (field) => ({ ...field, ccd: [id], ccdMatch: { status: "existing" } }));
}

/** An unsure row decided as a new field, with the id and type proposed for it. */
export function chooseNew(spec: FormSpec, sectionIndex: number, fieldIndex: number): FormSpec {
  return mapGroup(spec, sectionIndex, fieldIndex, (field) => {
    const proposed = field.ccdMatch?.newField;
    return proposed ? { ...field, ccd: [proposed.id], ccdMatch: { status: "new", newField: proposed } } : field;
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
    return { ...field, ccd: [next.id], ccdMatch: { ...field.ccdMatch, newField: next } };
  });
}

/** What the header counts: the case fields to add, and the rows still to choose. */
export function ccdCounts(spec: FormSpec): { newFields: number; unsure: number } {
  const unsure = new Set(
    spec.sections.flatMap((s) => s.fields.flatMap((f) => (f.ccdMatch?.status === "unsure" && f.ccdMatch.newField ? [f.ccdMatch.newField.id] : [])))
  );
  return { newFields: newCcdFields(spec).length, unsure: unsure.size };
}

/** The rows a CCD job answers, as matching reads them. */
export function ccdFieldsFromRows(rows: readonly CcdRow[]): CcdField[] {
  return rows.map((r) => ({
    id: r.ID,
    label: r.Label ?? "",
    type: r.FieldType,
    ...(r.FieldTypeParameter ? { typeParameter: r.FieldTypeParameter } : {}),
    ...(r.HintText ? { hint: r.HintText } : {})
  }));
}

export interface CcdRow {
  ID: string;
  Label?: string;
  FieldType: string;
  FieldTypeParameter?: string;
  HintText?: string;
}

/** The CCD FieldTypes a new field is offered, beside whatever type it already has. */
export const NEW_FIELD_TYPES = [
  "Text",
  "TextArea",
  "Email",
  "PhoneUK",
  "Postcode",
  "Number",
  "Date",
  "YesOrNo",
  "FixedRadioList",
  "FixedList",
  "MultiSelectList",
  "AddressUK",
  "AddressGlobalUK"
] as const;
