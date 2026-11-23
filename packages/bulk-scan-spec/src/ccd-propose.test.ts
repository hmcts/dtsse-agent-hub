import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { ccdDefinitionOf, loadCcdDefinition, proposeCcd, readCcdDefinition } from "./ccd-propose.ts";
import { unzipFiles } from "./unzip.ts";

const rows = (...ids: string[]) => JSON.stringify(ids.map((ID) => ({ ID, FieldType: "Text" })));

const text = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const typed = (CaseTypeID: string, ...ids: string[]) => ids.map((ID) => ({ CaseTypeID, ID, FieldType: "Text" }));

/** A zip with each entry deflated, or stored when its path ends .stored, as a build's definitions folder zipped by a person is. */
function zipOf(entries: Record<string, string>): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [path, content] of Object.entries(entries)) {
    const raw = Buffer.from(content);
    const stored = path.endsWith(".stored");
    const data = stored ? raw : deflateRawSync(raw);
    const name = Buffer.from(path);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(stored ? 0 : 8, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    parts.push(local, name, data);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, directory, end]));
}

describe("unzipFiles", () => {
  it("should inflate the entries it is asked for, stored or deflated, and read none of the others", () => {
    const zip = zipOf({ "a/CaseField.json": "[1]", "b.stored": "plain", "c/other.txt": "no" });
    const files = unzipFiles(zip, (p) => !p.endsWith("other.txt")).map((f) => [f.path, new TextDecoder().decode(f.content)]);
    expect(files).toEqual([
      ["a/CaseField.json", "[1]"],
      ["b.stored", "plain"]
    ]);
  });

  it("should stop when the entries add up to more than the total cap, or there are more than the entry cap", () => {
    const zip = zipOf({ "a.json": "x".repeat(600), "b.json": "y".repeat(600) });
    expect(() => unzipFiles(zip, () => true, { maxTotalBytes: 1000 })).toThrow("expands to more than");
    expect(() => unzipFiles(zip, () => true, { maxEntries: 1 })).toThrow("more than 1 entries");
    expect(unzipFiles(zip, () => true, { maxTotalBytes: 1200, maxEntries: 2 })).toHaveLength(2);
  });

  it("should refuse bytes that are not a zip", () => {
    expect(() => unzipFiles(new Uint8Array(40), () => true)).toThrow("not a zip");
  });
});

describe("ccdDefinitionOf", () => {
  it("should read the ids of a definition, leaving out label fields and rows without an id, and name its case type", () => {
    const rows = [...typed("CIC", "applicantName"), { CaseTypeID: "CIC", ID: "heading", FieldType: "Label" }, { ID: 5 }];
    expect(ccdDefinitionOf(rows)).toEqual({ caseType: "CIC", fields: ["applicantName"] });
  });

  it("should leave the case type out when every row's is blank, and take the one that was typed", () => {
    expect(ccdDefinitionOf(typed("", "a"))).toEqual({ fields: ["a"] });
    expect(ccdDefinitionOf(typed("", "a"), "Typed")).toEqual({ caseType: "Typed", fields: ["a"] });
  });

  it("should keep only the typed case type's rows when the definition holds several", () => {
    const rows = [...typed("One", "a"), ...typed("Two", "b")];
    expect(ccdDefinitionOf(rows, "Two")).toEqual({ caseType: "Two", fields: ["b"] });
  });

  it("should list the case types found when the typed one is not one of them", () => {
    expect(() => ccdDefinitionOf([...typed("One", "a"), ...typed("Two", "b")], "Three")).toThrow('has no case type "Three": it holds One, Two');
    expect(() => ccdDefinitionOf(typed("CIC", "a"), "Other")).toThrow('has no case type "Other": it holds CIC');
  });

  it("should ask which case type when the definition holds several and none was typed", () => {
    expect(() => ccdDefinitionOf([...typed("One", "a"), ...typed("Two", "b")])).toThrow("holds 2 case types (One, Two)");
  });
});

describe("readCcdDefinition", () => {
  it("should read a CaseField.json from its bytes", async () => {
    expect(await readCcdDefinition(text(typed("CIC", "a", "b")))).toEqual({ caseType: "CIC", fields: ["a", "b"] });
  });

  it("should read a zip of a generated definitions folder, whatever its depth, with several case types", async () => {
    const zip = zipOf({
      "definitions/CaseField.json": JSON.stringify(typed("", "shared")),
      "definitions/CIC/CaseField.json": JSON.stringify(typed("CIC", "a", "b")),
      "definitions/CIC/State.json": "[]",
      "definitions/Other/CaseField.json": JSON.stringify(typed("Other", "c"))
    });
    expect(await readCcdDefinition(zip, "CIC")).toEqual({ caseType: "CIC", fields: ["a", "b"] });
    await expect(readCcdDefinition(zip)).rejects.toThrow("holds 2 case types (CIC, Other)");
  });

  it("should skip the __MACOSX and ._ entries a macOS zip adds, which are not JSON", async () => {
    const zip = zipOf({
      "definitions/CIC/CaseField/a.json": JSON.stringify(typed("CIC", "a")),
      "definitions/CIC/CaseField/._a.json": "\u0000\u0005binary",
      "__MACOSX/definitions/CIC/CaseField/a.json": "\u0000\u0005binary"
    });
    expect(await readCcdDefinition(zip)).toEqual({ caseType: "CIC", fields: ["a"] });
  });

  it("should name the file in the zip that is not valid JSON", async () => {
    const zip = zipOf({ "definitions/CIC/CaseField.json": "not json" });
    await expect(readCcdDefinition(zip)).rejects.toThrow("definitions/CIC/CaseField.json is not valid JSON");
  });

  it("should read a zip whose case fields are a CaseField folder of JSON files", async () => {
    const zip = zipOf({
      "CIC/CaseField/b.json": JSON.stringify(typed("CIC", "second")),
      "CIC/CaseField/a.json": JSON.stringify(typed("CIC", "first"))
    });
    expect(await readCcdDefinition(zip)).toEqual({ caseType: "CIC", fields: ["first", "second"] });
  });

  it("should read the CaseField sheet of a definition spreadsheet", async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("CaseField");
    sheet.addRow(["CaseField"]);
    sheet.addRow(["Notes"]);
    sheet.addRow(["CaseTypeID", "ID", "FieldType"]);
    sheet.addRow(["CIC", "a", "Text"]);
    sheet.addRow(["CIC", "title", "Label"]);
    const bytes = new Uint8Array((await book.xlsx.writeBuffer()) as ArrayBuffer);
    expect(await readCcdDefinition(bytes)).toEqual({ caseType: "CIC", fields: ["a"] });
  });

  it("should say so when a spreadsheet has no CaseField sheet", async () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet("Other").addRow(["x"]);
    await expect(readCcdDefinition(new Uint8Array((await book.xlsx.writeBuffer()) as ArrayBuffer))).rejects.toThrow("no CaseField sheet");
  });

  it("should say so when the bytes are none of those", async () => {
    await expect(readCcdDefinition(new TextEncoder().encode("hello"))).rejects.toThrow("not a CaseField.json");
  });

  it("should read nothing from a JSON file that is not a list", async () => {
    expect(await readCcdDefinition(text({}))).toEqual({ fields: [] });
  });
});

describe("loadCcdDefinition", () => {
  it("should read a CaseField.json file or the directory holding it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccd-"));
    writeFileSync(join(dir, "CaseField.json"), JSON.stringify(typed("CIC", "applicant1FirstName")));
    expect(await loadCcdDefinition(dir)).toEqual({ caseType: "CIC", fields: ["applicant1FirstName"] });
    expect(await loadCcdDefinition(join(dir, "CaseField.json"))).toEqual({ caseType: "CIC", fields: ["applicant1FirstName"] });
  });

  it("should read every file of a CaseField folder in name order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccd-"));
    mkdirSync(join(dir, "CaseField"));
    writeFileSync(join(dir, "CaseField", "b.json"), rows("second"));
    writeFileSync(join(dir, "CaseField", "a.json"), rows("first"));
    writeFileSync(join(dir, "CaseField", "notes.txt"), "ignored");
    expect((await loadCcdDefinition(dir)).fields).toEqual(["first", "second"]);
  });

  it("should say so when the directory holds no case fields", async () => {
    await expect(loadCcdDefinition(mkdtempSync(join(tmpdir(), "ccd-")))).rejects.toThrow("no CaseField.json");
  });
});

describe("proposeCcd", () => {
  const fields = ["applicant1FirstName", "applicant2FirstName", "marriageDate"];

  it("should propose the field whose id wording is closest, and nothing when none is close", () => {
    const [first, none] = proposeCcd(["soleOrApplicant1FirstName First name(s) Full name", "Court name"], fields);
    expect(first).toMatchObject({ id: "applicant1FirstName" });
    expect(none).toBeUndefined();
  });

  it("should let two contexts share one CCD field", () => {
    const found = proposeCcd(["applicant1FirstName", "applicant 1 first name"], fields);
    expect(found.map((f) => f?.id)).toEqual(["applicant1FirstName", "applicant1FirstName"]);
  });
});
