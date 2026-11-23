import { describe, expect, it } from "vitest";
import { type CcdField, compatible, matchCcd, newCcdFields, stylePrefix } from "./ccd-match.ts";
import { caseDataSnippet, newCcdFieldFiles } from "./codegen/new-ccd-fields.ts";
import { type Field, type FormSpec, fieldSchema, formSpecSchema } from "./schema.ts";

const ccd = (id: string, type: string, label = "", extra: Partial<CcdField> = {}): CcdField => ({ id, type, label, ...extra });
const field = (label: string, extra: Record<string, unknown> = {}): Field =>
  fieldSchema.parse({ label, keys: [`k${label.length}${Math.abs(hash(label))}`], ...extra });
const hash = (s: string): number => [...s].reduce((n, c) => (n * 31 + c.charCodeAt(0)) | 0, 7);
const spec = (fields: Field[], title = "Section 1 – Your details", extra: Record<string, unknown> = {}): FormSpec =>
  formSpecSchema.parse({ form: { name: "F", formType: "F1", ...extra }, sections: [{ id: "1", title, fields }] });
const rowsOf = (result: FormSpec): Field[] => result.sections.flatMap((s) => s.fields);

const CASE_TYPE = [
  ccd("applicantFirstName", "Text", "First name"),
  ccd("applicantDateOfBirth", "Date", "Date of birth"),
  ccd("applicantAddress", "AddressUK", "Address"),
  ccd("applicantEmail", "Email", "Email address"),
  ccd("isRepresented", "YesOrNo", "Is the applicant represented?"),
  ccd("applicationType", "FixedRadioList", "Application type", { typeParameter: "ApplicationType" }),
  ccd("dateOfBirthNote", "Text", "Date of birth note")
];

describe("compatible", () => {
  it.each([
    ["date", "Date", true],
    ["date", "Text", false],
    ["address", "AddressGlobalUK", true],
    ["address", "Text", false],
    ["yesno", "YesOrNo", true],
    ["yesno", "Text", false],
    ["choice", "MultiSelectList", true],
    ["choice", "YesOrNo", false],
    ["text", "PhoneUK", true],
    ["text", "Date", false],
    ["number", "Number", true],
    ["number", "Text", false]
  ] as const)("should say a %s input fits %s when %s", (shape, type, fits) => {
    expect(compatible(shape, { type })).toBe(fits);
  });

  it("should accept a Yes/No radio list for a yes or no answer", () => {
    expect(compatible("yesno", { type: "FixedRadioList", typeParameter: "YesNo" })).toBe(true);
  });
});

describe("matchCcd", () => {
  it("should mark a field existing and set its id when one case field matches by id wording and its type fits", () => {
    const [row] = rowsOf(matchCcd(spec([field("First name")]), CASE_TYPE));
    expect(row?.ccd).toEqual(["applicantFirstName"]);
    expect(row?.ccdMatch?.status).toBe("existing");
  });

  it("should not match a date input to a text field that has the same words", () => {
    const [row] = rowsOf(matchCcd(spec([field("Date of birth", { inputType: "date" })]), CASE_TYPE));
    expect(row?.ccd).toEqual(["applicantDateOfBirth"]);
  });

  it("should mark a field unsure and keep its candidates when the only close field has a type the input cannot fit", () => {
    const [row] = rowsOf(matchCcd(spec([field("Date of birth note", { inputType: "date" })]), [ccd("dateOfBirthNote", "Text", "Date of birth note")]));
    expect(row?.ccdMatch?.status).toBe("unsure");
    expect(row?.ccdMatch?.candidates?.map((c) => c.id)).toEqual(["dateOfBirthNote"]);
    expect(row?.ccd).toEqual([]);
  });

  it("should mark a field unsure with at most three candidates when several case fields match equally well", () => {
    const many = ["a", "b", "c", "d"].map((p) => ccd(`${p}Email`, "Email", "Email address"));
    const [row] = rowsOf(matchCcd(spec([field("Email address")]), many));
    expect(row?.ccdMatch?.status).toBe("unsure");
    expect(row?.ccdMatch?.candidates).toHaveLength(3);
    expect(row?.ccdMatch?.newField?.type).toBe("Email");
  });

  it("should match on the case field's label when its id is not worded like the question", () => {
    const [row] = rowsOf(
      matchCcd(spec([field("Date of the hearing", { inputType: "date" })]), [ccd("hrgDt", "Date", "Date of the hearing"), ccd("x1", "Date", "Other")])
    );
    expect(row?.ccdMatch?.candidates?.[0]?.id ?? row?.ccd[0]).toBe("hrgDt");
  });

  it("should treat Yes and No checkboxes as a YesOrNo field", () => {
    const yesNo = field("Is the applicant represented?", {
      inputType: "checkbox",
      keys: ["yes", "no"],
      group: {
        kind: "xor",
        size: 2,
        options: [
          { key: "yes", label: "Yes" },
          { key: "no", label: "No" }
        ]
      }
    });
    expect(rowsOf(matchCcd(spec([yesNo]), CASE_TYPE))[0]?.ccd).toEqual(["isRepresented"]);
  });

  it("should treat an XoR group of choices as a list field", () => {
    const choice = field("Application type", {
      inputType: "checkbox",
      keys: ["divorce", "dissolution"],
      group: {
        kind: "xor",
        size: 2,
        options: [
          { key: "divorce", label: "Divorce" },
          { key: "dissolution", label: "Dissolution" }
        ]
      }
    });
    expect(rowsOf(matchCcd(spec([choice]), CASE_TYPE))[0]?.ccd).toEqual(["applicationType"]);
  });

  it("should treat the address lines under an address question as one address field", () => {
    const rows = rowsOf(
      matchCcd(spec([field("First line of address", { id: "2.2" }), field("Town or city"), field("Postcode"), field("Phone number", { id: "2.3" })]), CASE_TYPE)
    );
    expect(rows.slice(0, 3).map((r) => r.ccd)).toEqual([["applicantAddress"], ["applicantAddress"], ["applicantAddress"]]);
    expect(rows[3]?.ccd).not.toEqual(["applicantAddress"]);
  });

  it("should treat a day, month and year box as one date field", () => {
    const rows = rowsOf(matchCcd(spec([field("Date of birth Day"), field("Month"), field("Year")]), CASE_TYPE));
    expect(rows.map((r) => r.ccd[0])).toEqual(["applicantDateOfBirth", "applicantDateOfBirth", "applicantDateOfBirth"]);
  });

  it("should mark a field new with a proposed id and FieldType when nothing fits", () => {
    const [row] = rowsOf(matchCcd(spec([field("National insurance number")]), CASE_TYPE));
    expect(row?.ccdMatch).toMatchObject({ status: "new", newField: { id: "nationalInsuranceNumber", type: "Text" } });
    expect(row?.ccd).toEqual(["nationalInsuranceNumber"]);
  });

  it("should propose the FieldType from the input type", () => {
    const types = rowsOf(
      matchCcd(
        spec([field("Date moved in", { inputType: "date" }), field("Why did you move?", { maxLength: 500 }), field("Do you rent?", { inputType: "checkbox" })]),
        [ccd("zzz", "Text")]
      )
    ).map((r) => r.ccdMatch?.newField?.type);
    expect(types).toEqual(["Date", "TextArea", "YesOrNo"]);
  });

  it("should name a new field in the service's own style when most of its ids share a prefix", () => {
    const pool = Array.from({ length: 12 }, (_, i) =>
      ccd(`cicCase${["Alpha", "Beta", "Gamma", "Delta", "Eps", "Zeta", "Eta", "Theta", "Iota", "Kappa", "Lambda", "Mu"][i]}`, "Text")
    );
    const [row] = rowsOf(matchCcd(spec([field("Incident location")]), pool));
    expect(row?.ccd).toEqual(["cicCaseIncidentLocation"]);
  });

  it("should leave the ids a person set alone and only say whether they exist, when keeping them", () => {
    const [known, unknown] = rowsOf(
      matchCcd(spec([field("Anything", { ccd: ["applicantEmail"] }), field("Else", { ccd: ["myNewField"] })]), CASE_TYPE, { keepSet: true })
    );
    expect(known).toMatchObject({ ccd: ["applicantEmail"], ccdMatch: { status: "existing" } });
    expect(unknown).toMatchObject({ ccd: ["myNewField"], ccdMatch: { status: "new", newField: { id: "myNewField" } } });
  });

  it("should not give two different questions the same case field when only one is a close match", () => {
    const rows = rowsOf(
      matchCcd(spec([field("Applicant first name"), field("First name of the other party")]), [ccd("applicantFirstName", "Text", "First name")])
    );
    expect(rows.filter((r) => r.ccd.includes("applicantFirstName"))).toHaveLength(1);
  });

  it("should leave label and QR rows alone", () => {
    const rows = rowsOf(matchCcd(spec([fieldSchema.parse({ role: "qr", label: "QR code", inputType: "qr" })]), CASE_TYPE));
    expect(rows[0]?.ccdMatch).toBeUndefined();
  });
});

describe("stylePrefix", () => {
  it("should find the lead words most ids share, and none when they are spread", () => {
    expect(stylePrefix(Array.from({ length: 20 }, (_, i) => (i < 8 ? `cicCaseX${i}` : `other${i}Thing`)))).toBe("cicCase");
    expect(stylePrefix(["alphaOne", "betaTwo", "gammaThree", "deltaFour", "epsFive", "zetaSix"])).toBe("");
  });
});

describe("new case fields", () => {
  const matched = matchCcd(
    spec([field("National insurance number"), field("Incident location")], "S", { ccdCaseTypeId: "T", ccdConfig: "config-generator" }),
    CASE_TYPE
  );

  it("should list each new field once with its id, FieldType and label", () => {
    expect(newCcdFields(matched).map((f) => [f.id, f.type, f.label])).toEqual([
      ["nationalInsuranceNumber", "Text", "National insurance number"],
      ["incidentLocation", "Text", "Incident location"]
    ]);
  });

  it("should write the list and, for a config-generator service, a CaseData snippet", () => {
    const files = newCcdFieldFiles(matched);
    expect(files.map((f) => f.path)).toEqual(["new-ccd-fields.json", "new-case-data-fields.java.txt"]);
    expect(JSON.parse(files[0]?.content as string)).toMatchObject({ caseType: "T", fields: [{ id: "nationalInsuranceNumber" }, { id: "incidentLocation" }] });
    expect(files[1]?.content).toContain(
      '@CCD(\n    label = "National insurance number",\n    access = {DefaultAccess.class}\n)\nprivate String nationalInsuranceNumber;'
    );
  });

  it("should write nothing when no field is new", () => {
    expect(newCcdFieldFiles(matchCcd(spec([field("First name")]), CASE_TYPE))).toEqual([]);
  });

  it("should omit the snippet when the service is not config-generator", () => {
    const json = newCcdFieldFiles({ ...matched, form: { ...matched.form, ccdConfig: "json" } });
    expect(json.map((f) => f.path)).toEqual(["new-ccd-fields.json"]);
  });

  it("should give a date and a list field their Java types and overrides", () => {
    const text = caseDataSnippet([
      { id: "movedIn", type: "Date", label: "Moved in" },
      { id: "kind", type: "FixedRadioList", label: "Kind" }
    ]);
    expect(text).toContain("private LocalDate movedIn;");
    expect(text).toContain('typeOverride = FixedRadioList,\n    typeParameterOverride = "Kind"');
  });
});
