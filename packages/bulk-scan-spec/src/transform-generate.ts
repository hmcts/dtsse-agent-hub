import ExcelJS from "exceljs";
import type { Compose, Field, FormSpec } from "./schema.ts";
import { TRANSFORM_COLUMNS } from "./schema.ts";
import { rowFor } from "./transform-render.ts";

const HEADERS = [
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
const WIDTHS = [10, 48, 12, 16, 36, 24, 48, 36, 36, 32, 64, 36];
const CCD_COLUMN = TRANSFORM_COLUMNS.indexOf("ccd") + 1;
const LAST_COLUMN = TRANSFORM_COLUMNS.length;

export function transformSheetName(spec: FormSpec): string {
  return `${spec.form.formType || spec.form.name || "Form"} BSS`;
}

function orderedFields(spec: FormSpec): Field[] {
  return spec.sections.flatMap((s) => (s.heading ? [s.heading, ...s.fields] : s.fields));
}

/** Contiguous rows that feed one composed CCD field share its CCD, logic and case path cells as one merged block. */
function composeRuns(fields: Field[], composes: Compose[]): { from: number; to: number }[] {
  const runs: { from: number; to: number }[] = [];
  let start = -1;
  const close = (end: number) => {
    if (start >= 0 && end > start) {
      runs.push({ from: start, to: end });
    }
    start = -1;
  };
  fields.forEach((f, i) => {
    const ccd = f.ccd.length === 1 ? f.ccd[0] : undefined;
    const member = f.role === "field" && f.keys.length === 1 && ccd !== undefined && composes.some((c) => c.ccd === ccd);
    const previous = fields[i - 1]?.ccd[0];
    if (member && start >= 0 && previous === ccd) {
      return;
    }
    close(i - 1);
    if (member) {
      start = i;
    }
  });
  close(fields.length - 1);
  return runs;
}

export function addTransformSheet(workbook: ExcelJS.Workbook, spec: FormSpec): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(transformSheetName(spec), { views: [{ state: "frozen", ySplit: 1 }] });
  const header = sheet.addRow(HEADERS);
  header.font = { bold: true };
  header.alignment = { vertical: "middle", wrapText: true };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E1F2" } };
  WIDTHS.forEach((width, i) => {
    sheet.getColumn(i + 1).width = width;
  });

  const fields = orderedFields(spec);
  const rendered = fields.map((f) => rowFor(f, spec.composes));
  for (const cells of rendered) {
    const row = sheet.addRow(cells);
    row.alignment = { vertical: "top", wrapText: true };
  }

  for (const run of composeRuns(fields, spec.composes)) {
    for (let col = CCD_COLUMN; col <= LAST_COLUMN; col++) {
      // Merging keeps only the top cell's text, so a column is merged only when every row of the run says the same.
      const texts = new Set(rendered.slice(run.from, run.to + 1).map((cells) => cells[col - 1]));
      if (texts.size === 1) {
        sheet.mergeCells(run.from + 2, col, run.to + 2, col);
      }
    }
  }
  return sheet;
}

export function generateTransformWorkbook(spec: FormSpec): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  addTransformSheet(workbook, spec);
  return workbook;
}
