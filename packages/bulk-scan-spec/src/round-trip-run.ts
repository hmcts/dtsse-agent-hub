import { isDeepStrictEqual } from "node:util";
import ExcelJS from "exceljs";
import { readWorkbook, selectSheet } from "./cells.ts";
import type { CellDiff, SheetDiff } from "./roundtrip.ts";
import { diffSheets } from "./roundtrip.ts";
import type { Bundle, TransformColumn } from "./schema.ts";
import { TRANSFORM_COLUMNS } from "./schema.ts";
import { generateSipWorkbook, sipRows } from "./sip-generate.ts";
import { importSip } from "./sip-import.ts";
import { isPageOrderExample, SIP } from "./sip-layout.ts";
import { generateTransformWorkbook } from "./transform-generate.ts";
import type { TransformImport } from "./transform-import.ts";
import { importTransformSheet } from "./transform-import.ts";
import { cosmeticallyEqual } from "./transform-render.ts";

export interface Differences {
  /** Per column, the cells whose text differs from the original, split into wording-only differences and differences of content. */
  byColumn: Record<string, { cosmetic: number; content: number }>;
  cells: (CellDiff & { column: number; kind: "cosmetic" | "content" })[];
}

export function classify(diff: SheetDiff): Differences {
  const byColumn: Differences["byColumn"] = Object.fromEntries(TRANSFORM_COLUMNS.map((c) => [c, { cosmetic: 0, content: 0 }]));
  const cells: Differences["cells"] = [];
  for (const c of diff.cells) {
    const name = TRANSFORM_COLUMNS[c.column - 1] as TransformColumn;
    const kind = cosmeticallyEqual(name, c.original, c.regenerated) ? "cosmetic" : "content";
    (byColumn[name] as { cosmetic: number; content: number })[kind]++;
    cells.push({ ...c, kind });
  }
  return { byColumn, cells };
}

export interface RoundTripReport {
  differences: Differences;
  imported: TransformImport;
  transform: SheetDiff;
  /** Re-importing the regenerated transformation sheet gives back the same spec. */
  specStable: boolean;
  sip: {
    rows: number;
    /** SIP rows read back from the generated workbook that differ from the rows the spec says to write. */
    mismatchedRows: number;
    /** Cells outside the regions the generator writes that differ from the template it started from. */
    untouchedDiffs: CellDiff[];
    formTabs: string[];
  };
  bundle: Bundle;
  outputs: { transform: ExcelJS.Workbook; sip: ExcelJS.Workbook };
}

function writtenRegion(sheetName: string, address: string, base: ExcelJS.Worksheet, forms: number): boolean {
  const m = /^([A-Z]+)(\d+)$/.exec(address);
  if (!m?.[1] || !m[2]) {
    return false;
  }
  const row = Number(m[2]);
  if (sheetName === SIP.overview.sheet) {
    // The service block (value columns C to G, rows 4 to 7) and the contact values (D to G, rows 8 to 23); the labels are the template's.
    const col = m[1].charCodeAt(0) - 64;
    return (
      m[1].length === 1 &&
      ((row >= SIP.overview.serviceName && row <= SIP.overview.signOffDate && col >= 3 && col <= 7) ||
        (row >= SIP.overview.firstContactRow && row < SIP.overview.firstContactRow + 16 && col >= 4 && col <= 7))
    );
  }
  if (sheetName === SIP.pageOrder.sheet) {
    return row >= SIP.pageOrder.firstRow && !isPageOrderExample(base, row);
  }
  if (sheetName === SIP.rampUp.sheet) {
    return m[1] === "A" && row >= SIP.rampUp.firstFormRow && row < SIP.rampUp.firstFormRow + Math.max(SIP.rampUp.placeholders, forms);
  }
  if (SIP.formSheetPattern.test(sheetName)) {
    if (row >= SIP.firstFieldRow) {
      return true;
    }
    if ((Object.values(SIP.descriptionRows) as number[]).includes(row)) {
      return m[1] !== "A";
    }
    if (m[1] === "M") {
      return row >= SIP.signOff.completedBy && row <= SIP.signOff.signOffDate;
    }
    return m[1] === "B" && (Object.values(SIP.headerRows) as number[]).includes(row);
  }
  return false;
}

/** Rows that differ where both lists have a row, plus one for each row only one list has. */
export function countMismatchedRows<T>(wanted: T[], got: T[]): number {
  const shared = Math.min(wanted.length, got.length);
  let differing = Math.abs(wanted.length - got.length);
  for (let i = 0; i < shared; i++) {
    if (!isDeepStrictEqual(wanted[i], got[i])) {
      differing++;
    }
  }
  return differing;
}

export async function roundTrip(transformPath: string, templatePath?: string, sheetName?: string): Promise<RoundTripReport> {
  const original = await readWorkbook(transformPath);
  const sheet = selectSheet(original, sheetName);
  const imported = importTransformSheet(sheet);
  const bundle: Bundle = { forms: [imported.spec] };

  const transformBook = generateTransformWorkbook(imported.spec);
  const transformBuffer = await transformBook.xlsx.writeBuffer();
  const reread = new ExcelJS.Workbook();
  await reread.xlsx.load(transformBuffer as ArrayBuffer);
  const regenerated = reread.worksheets[0];
  if (!regenerated) {
    throw new Error("regenerated workbook is empty");
  }
  const transform = diffSheets(sheet, regenerated, TRANSFORM_COLUMNS.length);
  const again = importTransformSheet(regenerated, imported.spec.form.formType);
  const specStable = isDeepStrictEqual(JSON.parse(JSON.stringify(again.spec)), JSON.parse(JSON.stringify(imported.spec)));

  const template = templatePath ? await readWorkbook(templatePath) : undefined;
  const pristine = templatePath ? await readWorkbook(templatePath) : undefined;
  const sipBook = generateSipWorkbook(bundle, template);
  const sipBuffer = await sipBook.xlsx.writeBuffer();
  const sipReread = new ExcelJS.Workbook();
  await sipReread.xlsx.load(sipBuffer as ArrayBuffer);
  const readBack = importSip(sipReread);
  const wanted = sipRows(imported.spec);
  const got = readBack.forms[0] ? sipRows(readBack.forms[0]) : [];
  const mismatchedRows = countMismatchedRows(wanted, got);

  const untouchedDiffs: CellDiff[] = [];
  if (pristine) {
    for (const base of pristine.worksheets) {
      const generated = sipReread.getWorksheet(base.name);
      if (!generated) {
        continue;
      }
      const diff = diffSheets(base, generated, 21);
      for (const c of diff.cells) {
        if (!writtenRegion(base.name, c.address, base, bundle.forms.length)) {
          untouchedDiffs.push({ ...c, address: `${base.name}!${c.address}` });
        }
      }
    }
  }
  return {
    differences: classify(transform),
    imported,
    transform,
    specStable,
    sip: { rows: wanted.length, mismatchedRows, untouchedDiffs, formTabs: sipReread.worksheets.map((s) => s.name).filter((n) => SIP.formSheetPattern.test(n)) },
    bundle,
    outputs: { transform: transformBook, sip: sipBook }
  };
}
