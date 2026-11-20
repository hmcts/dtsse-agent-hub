import type ExcelJS from "exceljs";
import { cellText, columnLetters } from "./cells.ts";
import { byCode } from "./compare.ts";

export interface CellDiff {
  address: string;
  /** 1-based column number of the cell. */
  column: number;
  original: string;
  regenerated: string;
}

export interface SheetDiff {
  cells: CellDiff[];
  originalOnlyMerges: string[];
  regeneratedOnlyMerges: string[];
  originalRows: number;
  regeneratedRows: number;
}

/** Cell-by-cell comparison of displayed text, plus the sets of merged ranges. */
export function diffSheets(original: ExcelJS.Worksheet, regenerated: ExcelJS.Worksheet, columns: number): SheetDiff {
  const rows = Math.max(original.rowCount, regenerated.rowCount);
  const cells: CellDiff[] = [];
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= columns; c++) {
      const a = cellText(original.getCell(r, c).value);
      const b = cellText(regenerated.getCell(r, c).value);
      if (a !== b) {
        cells.push({ address: `${columnLetters(c)}${r}`, column: c, original: a, regenerated: b });
      }
    }
  }
  const mergesOf = (s: ExcelJS.Worksheet) => new Set<string>(s.model.merges);
  const [ma, mb] = [mergesOf(original), mergesOf(regenerated)];
  return {
    cells,
    originalOnlyMerges: [...ma].filter((m) => !mb.has(m)).sort(byCode),
    regeneratedOnlyMerges: [...mb].filter((m) => !ma.has(m)).sort(byCode),
    originalRows: original.rowCount,
    regeneratedRows: regenerated.rowCount
  };
}
