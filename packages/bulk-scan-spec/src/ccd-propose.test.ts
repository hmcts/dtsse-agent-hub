import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCcdFields, proposeCcd } from "./ccd-propose.ts";

const rows = (...ids: string[]) => JSON.stringify(ids.map((ID) => ({ ID, FieldType: "Text" })));

describe("loadCcdFields", () => {
  it("should read the ids of a CaseField.json, leaving out label fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccd-"));
    writeFileSync(
      join(dir, "CaseField.json"),
      JSON.stringify([{ ID: "applicant1FirstName", FieldType: "Text" }, { ID: "heading", FieldType: "Label" }, { Other: 1 }])
    );
    expect(loadCcdFields(dir)).toEqual(["applicant1FirstName"]);
    expect(loadCcdFields(join(dir, "CaseField.json"))).toEqual(["applicant1FirstName"]);
  });

  it("should read every file of a CaseField folder in name order", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccd-"));
    mkdirSync(join(dir, "CaseField"));
    writeFileSync(join(dir, "CaseField", "b.json"), rows("second"));
    writeFileSync(join(dir, "CaseField", "a.json"), rows("first"));
    writeFileSync(join(dir, "CaseField", "notes.txt"), "ignored");
    expect(loadCcdFields(dir)).toEqual(["first", "second"]);
  });

  it("should read nothing from a file that is not a list", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccd-"));
    writeFileSync(join(dir, "x.json"), "{}");
    expect(loadCcdFields(join(dir, "x.json"))).toEqual([]);
  });

  it("should say so when the directory holds no case fields", () => {
    expect(() => loadCcdFields(mkdtempSync(join(tmpdir(), "ccd-")))).toThrow("no CaseField.json");
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
