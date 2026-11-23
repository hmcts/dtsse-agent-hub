import { NEW_FIELD_TYPES, type NewFieldType, newCcdFields } from "../ccd-match.ts";
import type { FormSpec } from "../schema.ts";
import type { OutputFile } from "./envelopes.ts";

/**
 * How a config-generator CaseData field of each CCD FieldType is declared. A list is an enum named after the field, which
 * the `@CCD` names as its type parameter; a multi-select list is a set of that enum.
 */
const JAVA: Record<NewFieldType, { type: (name: string) => string; override?: string; parameter?: boolean }> = {
  Text: { type: () => "String" },
  TextArea: { type: () => "String", override: "TextArea" },
  Email: { type: () => "String", override: "Email" },
  PhoneUK: { type: () => "String", override: "PhoneUK" },
  Postcode: { type: () => "String", override: "Postcode" },
  Number: { type: () => "Integer" },
  Date: { type: () => "LocalDate" },
  DateTime: { type: () => "LocalDateTime" },
  YesOrNo: { type: () => "YesOrNo" },
  AddressUK: { type: () => "AddressUK" },
  AddressGlobalUK: { type: () => "AddressGlobalUK" },
  FixedRadioList: { type: (name) => name, override: "FixedRadioList", parameter: true },
  FixedList: { type: (name) => name, override: "FixedList", parameter: true },
  MultiSelectList: { type: (name) => `Set<${name}>`, override: "MultiSelectList", parameter: true }
};

const isNewFieldType = (type: string): type is NewFieldType => (NEW_FIELD_TYPES as readonly string[]).includes(type);

const quote = (text: string): string => JSON.stringify(text);

/** `@CCD` fields for CaseData in the style the services' own classes use, for the Assistant to place and adjust. */
export function caseDataSnippet(fields: { id: string; type: string; label: string }[]): string {
  const blocks = fields.map((f) => {
    const java = JAVA[isNewFieldType(f.type) ? f.type : "Text"];
    const name = `${f.id.charAt(0).toUpperCase()}${f.id.slice(1)}`;
    const lines = [
      `    label = ${quote(f.label)}`,
      ...(java.override ? [`    typeOverride = ${java.override}`] : []),
      ...(java.parameter ? [`    typeParameterOverride = ${quote(name)}`] : []),
      "    access = {DefaultAccess.class}"
    ];
    return `@CCD(\n${lines.join(",\n")}\n)\nprivate ${java.type(name)} ${f.id};`;
  });
  return `${blocks.join("\n\n")}\n`;
}

/**
 * The case fields the form needs that its case type does not have, for the service's code: the list, and a CaseData
 * snippet for a config-generator service. An id with a dot is a member of a complex type, which is not a CaseData field
 * of its own, so it is listed under `complexMembers` with the field that holds the type and left out of the snippet.
 */
export function newCcdFieldFiles(spec: FormSpec): OutputFile[] {
  const all = newCcdFields(spec);
  if (all.length === 0) {
    return [];
  }
  const fields = all.filter((f) => !f.id.includes("."));
  const complexMembers = all
    .filter((f) => f.id.includes("."))
    .map((f) => ({ parent: f.id.slice(0, f.id.lastIndexOf(".")), id: f.id.slice(f.id.lastIndexOf(".") + 1), type: f.type, label: f.label }));
  return [
    { path: "new-ccd-fields.json", content: `${JSON.stringify({ caseType: spec.form.ccdCaseTypeId ?? null, fields, complexMembers }, null, 2)}\n` },
    ...(spec.form.ccdConfig === "config-generator" && fields.length > 0 ? [{ path: "new-case-data-fields.java.txt", content: caseDataSnippet(fields) }] : [])
  ];
}
