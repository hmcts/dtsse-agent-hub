import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { readTable, writeRequest } from "../xlsx.ts";

test("a request round-trips, and only the Welsh column is unlocked", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "welsh-xlsx-")), "request.xlsx");
  await writeRequest(
    path,
    [
      { ref: "CY-0001", english: "Hello {{name}}", context: "apps/web/src/pages/home/en.ts:greeting", notes: "" },
      { ref: "CY-0002", english: "Sign out", context: "header", notes: "link text" }
    ],
    { batch: "demo-2026-10-28", service: "demo", created: "2026-10-28" }
  );

  const table = await readTable(path);
  assert.equal(table.sheet, "Translations");
  assert.deepEqual(
    table.records.map((r) => [r.fields.Ref, r.english, r.welsh]),
    [
      ["CY-0001", "Hello {{name}}", ""],
      ["CY-0002", "Sign out", ""]
    ]
  );

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.getWorksheet("Translations")!;
  assert.notEqual(ws.getCell("B2").protection?.locked, false, "locked is the default, so it is not written out");
  assert.equal((ws as unknown as { sheetProtection?: { sheet?: boolean } }).sheetProtection?.sheet, true);
  assert.equal(ws.getCell("C2").protection?.locked, false);
});

test("reader finds a padded header below row 1 and keeps rich text", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "welsh-xlsx-")), "legacy.xlsx");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow([]);
  ws.addRow(["    English", "Welsh"]);
  ws.addRow(["Back", { richText: [{ text: "Yn " }, { text: "ôl", font: { bold: true } }] }]);
  await wb.xlsx.writeFile(path);

  const table = await readTable(path);
  assert.equal(table.headerRow, 2);
  assert.deepEqual(
    table.records.map((r) => [r.english, r.welsh]),
    [["Back", "Yn ôl"]]
  );
});
