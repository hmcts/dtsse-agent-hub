import { newCcdFields } from "../ccd-match.ts";
import type { FormSpec } from "../schema.ts";
import type { OutputFile } from "./envelopes.ts";

/** The Java type a config-generator CaseData field of a CCD FieldType is declared as, and the `@CCD` override it needs. */
const JAVA: Record<string, { type: string; override?: string }> = {
  Text: { type: "String" },
  TextArea: { type: "String", override: "TextArea" },
  Email: { type: "String", override: "Email" },
  PhoneUK: { type: "String", override: "PhoneUK" },
  Postcode: { type: "String", override: "Postcode" },
  Number: { type: "Integer" },
  Date: { type: "LocalDate" },
  YesOrNo: { type: "YesOrNo" },
  AddressUK: { type: "AddressUK" },
  AddressGlobalUK: { type: "AddressGlobalUK" },
  FixedRadioList: { type: "String", override: "FixedRadioList" }
};

const quote = (text: string): string => JSON.stringify(text);

/** `@CCD` fields for CaseData in the style the services' own classes use, for the Assistant to place and adjust. */
export function caseDataSnippet(fields: { id: string; type: string; label: string }[]): string {
  const blocks = fields.map((f) => {
    const java = JAVA[f.type] ?? { type: "String" };
    const lines = [
      `    label = ${quote(f.label)}`,
      ...(java.override ? [`    typeOverride = ${java.override}`] : []),
      ...(f.type === "FixedRadioList" ? [`    typeParameterOverride = ${quote(`${f.id.charAt(0).toUpperCase()}${f.id.slice(1)}`)}`] : []),
      "    access = {DefaultAccess.class}"
    ];
    return `@CCD(\n${lines.join(",\n")}\n)\nprivate ${java.type} ${f.id};`;
  });
  return `${blocks.join("\n\n")}\n`;
}

/** The case fields the form needs that its case type does not have, for the service's code: the list, and a CaseData snippet for a config-generator service. */
export function newCcdFieldFiles(spec: FormSpec): OutputFile[] {
  const fields = newCcdFields(spec);
  if (fields.length === 0) {
    return [];
  }
  return [
    { path: "new-ccd-fields.json", content: `${JSON.stringify({ caseType: spec.form.ccdCaseTypeId ?? null, fields }, null, 2)}\n` },
    ...(spec.form.ccdConfig === "config-generator" ? [{ path: "new-case-data-fields.java.txt", content: caseDataSnippet(fields) }] : [])
  ];
}
