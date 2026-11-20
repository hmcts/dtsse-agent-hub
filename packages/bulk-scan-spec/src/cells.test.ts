import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { cellText, isRichText, readWorkbook, readWorkbookBytes, rowTexts, selectSheet } from "./cells.ts";

describe("selectSheet", () => {
  it("should find a sheet by name, default to the first, and fail clearly when the named one is missing", () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet("First");
    book.addWorksheet("D8 BSS");
    expect(selectSheet(book, "D8 BSS").name).toBe("D8 BSS");
    expect(selectSheet(book, undefined).name).toBe("First");
    expect(() => selectSheet(book, "Nope")).toThrow(/Nope/);
  });
});

describe("cellText", () => {
  it("should read each kind of cell value as the text the cell shows", () => {
    expect(cellText(null)).toBe("");
    expect(cellText(undefined)).toBe("");
    expect(cellText("plain")).toBe("plain");
    expect(cellText(12)).toBe("12");
    expect(cellText(true)).toBe("true");
    expect(cellText(new Date(Date.UTC(2022, 0, 18)))).toBe("2022-01-18");
    expect(cellText(new Date(Date.UTC(2022, 0, 18, 9, 30)))).toBe("2022-01-18T09:30:00.000Z");
    expect(cellText({ richText: [{ text: "a" }, { text: "b" }] })).toBe("ab");
    expect(cellText({ formula: "A1", result: 3 })).toBe("3");
    expect(cellText({ text: "link", hyperlink: "http://x" })).toBe("link");
    expect(cellText({ error: "#N/A" })).toBe("#N/A");
  });

  it("should read a row of cells as texts and tell rich text from plain when a workbook is read back", async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("S");
    sheet.addRow(["a", 2]);
    expect(rowTexts(sheet, 1, 3)).toEqual(["a", "2", ""]);
    expect(isRichText({ richText: [] })).toBe(true);
    expect(isRichText("a")).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "cells-"));
    await book.xlsx.writeFile(join(dir, "b.xlsx"));
    expect((await readWorkbook(join(dir, "b.xlsx"))).getWorksheet("S")?.getCell(1, 1).value).toBe("a");
  });
});

describe("workbooks from bytes", () => {
  it("should read a workbook held in memory", async () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet("S").addRow(["a"]);
    const bytes = new Uint8Array((await book.xlsx.writeBuffer()) as ArrayBuffer);
    expect((await readWorkbookBytes(bytes)).getWorksheet("S")?.getCell(1, 1).value).toBe("a");
  });
});
