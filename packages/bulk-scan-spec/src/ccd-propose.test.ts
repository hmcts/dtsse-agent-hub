import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ccdDefinitionOf, loadCcdDefinition, proposeCcd } from "./ccd-propose.ts";

const rows = (...ids: string[]) => JSON.stringify(ids.map((ID) => ({ ID, FieldType: "Text" })));
const typed = (CaseTypeID: string, ...ids: string[]) => ids.map((ID) => ({ CaseTypeID, ID, FieldType: "Text" }));

describe("ccdDefinitionOf", () => {
  it("should name the case type and list only case field ids when the definition has label fields and rows without an id", () => {
    const list = [...typed("CIC", "applicantName"), { CaseTypeID: "CIC", ID: "heading", FieldType: "Label" }, { ID: "", FieldType: "Text" }];
    expect(ccdDefinitionOf(list)).toEqual({ caseType: "CIC", fields: ["applicantName"] });
  });

  it("should leave the case type out when every row's is blank, and take the one that was typed", () => {
    expect(ccdDefinitionOf(typed("", "a"))).toEqual({ fields: ["a"] });
    expect(ccdDefinitionOf(typed("", "a"), "Typed")).toEqual({ caseType: "Typed", fields: ["a"] });
  });

  it("should keep only the typed case type's rows when the definition holds several", () => {
    expect(ccdDefinitionOf([...typed("One", "a"), ...typed("Two", "b")], "Two")).toEqual({ caseType: "Two", fields: ["b"] });
  });

  it("should list the case types found when the typed one is not one of them", () => {
    expect(() => ccdDefinitionOf([...typed("One", "a"), ...typed("Two", "b")], "Three")).toThrow('has no case type "Three": it holds One, Two');
    expect(() => ccdDefinitionOf(typed("CIC", "a"), "Other")).toThrow('has no case type "Other": it holds CIC');
  });

  it("should ask which case type when the definition holds several and none was typed", () => {
    expect(() => ccdDefinitionOf([...typed("One", "a"), ...typed("Two", "b")])).toThrow("holds 2 case types (One, Two)");
  });

  it("should refuse the definition, saying what it holds, when it is not a list of case fields", () => {
    expect(() => ccdDefinitionOf({})).toThrow("that definition is a JSON object, not a list of case fields");
    expect(() => ccdDefinitionOf([{ ID: "createCase", Name: "Create", CaseTypeID: "CIC" }])).toThrow(
      "that definition is not a CaseField list: its rows have no ID and FieldType (they have CaseTypeID, ID, Name)"
    );
  });
});

describe("loadCcdDefinition", () => {
  it("should read the same definition when given a CaseField.json file or the directory holding it", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccd-"));
    writeFileSync(join(dir, "CaseField.json"), JSON.stringify(typed("CIC", "applicant1FirstName")));
    expect(loadCcdDefinition(dir)).toEqual({ caseType: "CIC", fields: ["applicant1FirstName"] });
    expect(loadCcdDefinition(join(dir, "CaseField.json"))).toEqual({ caseType: "CIC", fields: ["applicant1FirstName"] });
  });

  it("should read every file of a CaseField folder in name order", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccd-"));
    mkdirSync(join(dir, "CaseField"));
    writeFileSync(join(dir, "CaseField", "b.json"), rows("second"));
    writeFileSync(join(dir, "CaseField", "a.json"), rows("first"));
    writeFileSync(join(dir, "CaseField", "notes.txt"), "ignored");
    expect(loadCcdDefinition(dir).fields).toEqual(["first", "second"]);
  });

  it("should refuse and name the file when a CaseEvent.json is given as the case fields or a file is not JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccd-"));
    writeFileSync(join(dir, "CaseEvent.json"), JSON.stringify([{ ID: "createCase", Name: "Create" }]));
    writeFileSync(join(dir, "bad.json"), "not json");
    expect(() => loadCcdDefinition(join(dir, "CaseEvent.json"))).toThrow("not a CaseField list");
    expect(() => loadCcdDefinition(join(dir, "bad.json"))).toThrow("bad.json is not valid JSON");
  });

  it("should say so when the directory holds no case fields", () => {
    expect(() => loadCcdDefinition(mkdtempSync(join(tmpdir(), "ccd-")))).toThrow("no CaseField.json");
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
