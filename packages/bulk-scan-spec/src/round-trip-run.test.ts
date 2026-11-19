import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildMiniD8 } from "./__fixtures__/d8-mini.ts";
import { countMismatchedRows, roundTrip } from "./round-trip-run.ts";

describe("round trip bookkeeping", () => {
  it("should count a missing row once when it is missing from several columns", () => {
    const row = (key: string) => ({ key });
    expect(countMismatchedRows([row("a"), row("b"), row("c")] as never, [row("a")] as never)).toBe(2);
    expect(countMismatchedRows([row("a")] as never, [row("a"), row("x")] as never)).toBe(1);
    expect(countMismatchedRows([row("a"), row("b")] as never, [row("a"), row("c")] as never)).toBe(1);
  });
});

describe("roundTrip --sheet", () => {
  it("should read the named sheet when the workbook has a cover sheet first", async () => {
    const mini = buildMiniD8().worksheets[0];
    const book = new ExcelJS.Workbook();
    book.addWorksheet("Cover").addRow(["Cover page"]);
    const target = book.addWorksheet("D8 BSS");
    mini?.eachRow((row) => target.addRow(row.values as ExcelJS.CellValue[]));
    const dir = mkdtempSync(join(tmpdir(), "rt-"));
    const path = join(dir, "book.xlsx");
    writeFileSync(path, new Uint8Array((await book.xlsx.writeBuffer()) as ArrayBuffer));
    const report = await roundTrip(path, undefined, "D8 BSS");
    expect(report.imported.parsedRows + report.imported.partialRows).toBeGreaterThan(0);
    await expect(roundTrip(path, undefined, "No such sheet")).rejects.toThrow(/no sheet/);
  });
});
