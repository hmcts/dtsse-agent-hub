import ExcelJS from "exceljs";
import type { FormSpec } from "../schema.ts";
import { fieldSchema, formSpecSchema } from "../schema.ts";

export const JAVA = { basePackage: "uk.gov.example.bulkscan", classPrefix: "T" };

export function spec(fields: unknown[], formType = "T"): FormSpec {
  return formSpecSchema.parse({ form: { formType, name: formType }, sections: [{ id: "1", title: "", fields: fields.map((f) => fieldSchema.parse(f)) }] });
}

export function fileText(files: { path: string; content: string }[], path: string): string {
  return files.find((f) => f.path === path)?.content ?? "";
}

export function balanced(text: string): boolean {
  let depth = 0;
  for (const c of text) {
    depth += c === "{" ? 1 : c === "}" ? -1 : 0;
    if (depth < 0) {
      return false;
    }
  }
  return depth === 0;
}

export const TRANSFORM_HEADER = [
  "ID",
  "Field name",
  "Data Type",
  "Mandatory / Optional",
  "Validation Rule",
  "Default Value",
  "Description (OCR -> MetaData JSON File Creation)",
  "MetaData Tag Name",
  "Comments / Business Rules",
  "CCD Casefield ID",
  "CCD Transformation + Validation Logic",
  "Case Path (success/warning/exception)"
];

export const YES_NO = `if yes
"metadata_field_name": "married"
"metadata_field_value": "Yes"
if no
"metadata_field_name": "married"
"metadata_field_value": "No"
else empty
"metadata_field_name": "married"
"metadata_field_value": ""
if both
"metadata_field_name": "married"
"metadata_field_value": "Both"
"metadata_field_name": "reason"
"metadata_field_value": ""`;

export function sheetWith(rows: string[][]): ExcelJS.Worksheet {
  const sheet = new ExcelJS.Workbook().addWorksheet("T BSS");
  sheet.addRow(TRANSFORM_HEADER);
  for (const row of rows) {
    sheet.addRow(row);
  }
  return sheet;
}
