/**
 * Spreadsheets to and from the Welsh Language Unit.
 *
 * Requests carry a Ref per English string; the WLU fills the Welsh column and
 * sends the file back. The reader is deliberately forgiving about layout
 * (extra columns, header not on row 1, padded header text) because returns
 * come back hand-edited.
 */

import ExcelJS from "exceljs";

export const REQUEST_HEADERS = ["Ref", "English", "Welsh (WLU to complete)", "Context / where it appears", "Notes for translator"];

export async function readTable(path: string): Promise<SheetTable> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  for (const ws of wb.worksheets) {
    for (let r = 1; r <= Math.min(ws.rowCount, 20); r++) {
      const header = rowValues(ws.getRow(r));
      const english = header.findIndex((h) => /^english\b/i.test(h));
      const welsh = header.findIndex((h) => /^(welsh|cymraeg)\b/i.test(h));
      if (english < 0 || welsh < 0) {
        continue;
      }
      const records: SheetRecord[] = [];
      for (let i = r + 1; i <= ws.rowCount; i++) {
        const values = rowValues(ws.getRow(i));
        if (values.every((v) => v === "")) {
          continue;
        }
        const fields = Object.fromEntries(header.map((h, c) => [h, values[c] ?? ""]).filter(([h]) => h));
        records.push({ row: i, english: values[english] ?? "", welsh: values[welsh] ?? "", fields });
      }
      return { sheet: ws.name, headerRow: r, headers: header, records };
    }
  }
  throw new Error(`${path}: no sheet has both an "English" and a "Welsh" header in its first 20 rows`);
}

/**
 * Write a request for the WLU. Only the Welsh column is editable; the sheet is
 * protected without a password, so it guards against slips rather than intent.
 */
export async function writeRequest(path: string, rows: RequestRow[], meta: RequestMeta): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "agent-hub welsh plugin";
  const ws = wb.addWorksheet("Translations");
  ws.columns = [
    { header: REQUEST_HEADERS[0], key: "ref", width: 14 },
    { header: REQUEST_HEADERS[1], key: "english", width: 60 },
    { header: REQUEST_HEADERS[2], key: "welsh", width: 60 },
    { header: REQUEST_HEADERS[3], key: "context", width: 50 },
    { header: REQUEST_HEADERS[4], key: "notes", width: 40 }
  ];
  for (const row of rows) {
    ws.addRow({ ...row, welsh: row.welsh ?? "" });
  }

  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.eachRow((row, n) => {
    row.alignment = { wrapText: true, vertical: "top" };
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.protection = { locked: !(col === 3 && n > 1) };
      if (col === 3 && n > 1) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
      }
    });
  });
  await ws.protect("", { formatColumns: true, formatRows: true, sort: false, autoFilter: true });

  const info = wb.addWorksheet("About this request");
  info.columns = [{ width: 24 }, { width: 90 }];
  info.addRows([
    ["Request", meta.batch],
    ["Service", meta.service],
    ["Created", meta.created],
    ["Strings", String(rows.length)],
    [
      "How to complete",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the translator's guide names the placeholder forms literally
      "Enter the Welsh in the yellow column only. Keep any placeholders such as {{name}}, {name}, ${name} or %{name} exactly as they appear in the English. Please do not change the Ref or English columns."
    ]
  ]);
  info.getColumn(1).font = { bold: true };

  await wb.xlsx.writeFile(path);
}

function rowValues(row: ExcelJS.Row): string[] {
  // Outer whitespace is spreadsheet padding, not content; inner text is kept verbatim.
  const out: string[] = [];
  for (let c = 1; c <= row.cellCount; c++) {
    out.push(cellText(row.getCell(c).value).trim());
  }
  return out;
}

function cellText(value: ExcelJS.CellValue): string {
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
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "object") {
    if ("richText" in value) {
      return value.richText.map((t) => t.text).join("");
    }
    if ("text" in value) {
      return String(value.text);
    }
    if ("result" in value) {
      return cellText(value.result as ExcelJS.CellValue);
    }
  }
  return String(value);
}

export interface SheetRecord {
  row: number;
  english: string;
  welsh: string;
  fields: Record<string, string>;
}

export interface SheetTable {
  sheet: string;
  headerRow: number;
  headers: string[];
  records: SheetRecord[];
}

export interface RequestRow {
  ref: string;
  english: string;
  welsh?: string;
  context: string;
  notes: string;
}

export interface RequestMeta {
  batch: string;
  service: string;
  created: string;
}
