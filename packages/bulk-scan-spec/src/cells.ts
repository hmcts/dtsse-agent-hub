import ExcelJS from "exceljs";

export function cellText(value: ExcelJS.CellValue | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) {
    // A date-only cell is midnight UTC; keep it as the date it shows, with no time or zone to shift it.
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  if ("richText" in value) {
    return value.richText.map((run) => run.text).join("");
  }
  if ("formula" in value || "sharedFormula" in value) {
    return cellText((value as { result?: ExcelJS.CellValue }).result);
  }
  if ("text" in value) {
    return cellText(value.text as ExcelJS.CellValue);
  }
  if ("error" in value) {
    return String(value.error);
  }
  return "";
}

/** The spreadsheet letters of a 1-based column number: 1 is A, 27 is AA. */
export function columnLetters(column: number): string {
  let n = column;
  let letters = "";
  while (n > 0) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

export async function readWorkbook(path: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  return workbook;
}

export function rowTexts(sheet: ExcelJS.Worksheet, row: number, columns: number): string[] {
  const out: string[] = [];
  for (let c = 1; c <= columns; c++) {
    out.push(cellText(sheet.getCell(row, c).value));
  }
  return out;
}

export function isRichText(value: ExcelJS.CellValue | undefined): boolean {
  return typeof value === "object" && value !== null && "richText" in value;
}

/** The named worksheet, or the first when no name is given; fails clearly when the name is not in the workbook. */
export function selectSheet(workbook: ExcelJS.Workbook, name: string | undefined): ExcelJS.Worksheet {
  const sheet = name ? workbook.getWorksheet(name) : workbook.worksheets[0];
  if (!sheet) {
    throw new Error(`no sheet ${name ? JSON.stringify(name) : "(the first)"} in the workbook`);
  }
  return sheet;
}
