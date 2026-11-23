import { describe, expect, it } from "vitest";
import { type CcdField, compatible, matchCcd, NEW_FIELD_TYPES, newCcdFields, stylePrefix } from "./ccd-match.ts";
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

  it("should accept a Yes/No radio list for a yes or no answer when its type parameter is YesNo", () => {
    expect(compatible("yesno", { type: "FixedRadioList", typeParameter: "YesNo" })).toBe(true);
  });
});

describe("matchCcd", () => {
  it("should mark a field existing and set its id when one case field matches by id wording and its type fits", () => {
    const [row] = rowsOf(matchCcd(spec([field("First name")]), CASE_TYPE));
    expect(row?.ccd).toEqual(["applicantFirstName"]);
    expect(row?.ccdMatch?.status).toBe("existing");
  });

  it("should not match a date input to a text field when the text field has the same words", () => {
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

  it("should treat the checkboxes as a YesOrNo field when their options are Yes and No", () => {
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

  it("should treat the group as a list field when its options are choices", () => {
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

  it("should treat the lines as one address field when they follow an address question", () => {
    const rows = rowsOf(
      matchCcd(spec([field("First line of address", { id: "2.2" }), field("Town or city"), field("Postcode"), field("Phone number", { id: "2.3" })]), CASE_TYPE)
    );
    expect(rows.slice(0, 3).map((r) => r.ccd)).toEqual([["applicantAddress"], ["applicantAddress"], ["applicantAddress"]]);
    expect(rows[3]?.ccd).not.toEqual(["applicantAddress"]);
  });

  it("should treat the boxes as one date field when they are day, month and year in a row", () => {
    const rows = rowsOf(matchCcd(spec([field("Date of birth Day"), field("Month"), field("Year")]), CASE_TYPE));
    expect(rows.map((r) => r.ccd[0])).toEqual(["applicantDateOfBirth", "applicantDateOfBirth", "applicantDateOfBirth"]);
  });

  it("should mark a field new with a proposed id and FieldType when nothing fits", () => {
    const [row] = rowsOf(matchCcd(spec([field("National insurance number")]), CASE_TYPE));
    expect(row?.ccdMatch).toMatchObject({ status: "new", newField: { id: "nationalInsuranceNumber", type: "Text" } });
    expect(row?.ccd).toEqual(["nationalInsuranceNumber"]);
  });

  it("should propose the FieldType from the input type when no case field fits", () => {
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

  it("should leave the row alone when it is a QR code", () => {
    const rows = rowsOf(matchCcd(spec([fieldSchema.parse({ role: "qr", label: "QR code", inputType: "qr" })]), CASE_TYPE));
    expect(rows[0]?.ccdMatch).toBeUndefined();
  });
});

describe("ids that came with the form", () => {
  it("should mark an id as the form's when the form already had it, so it is kept across case types", () => {
    const [row] = rowsOf(matchCcd(spec([field("Anything", { ccd: ["applicantEmail"] })]), CASE_TYPE, { keepSet: true }));

    expect(row?.ccdMatch).toMatchObject({ status: "existing", chosenBy: "form" });
  });
});

describe("rows that share a decision", () => {
  const address = () =>
    spec([
      field("First line of address", { id: "2.2", ccd: ["applicantAddress.AddressLine1"] }),
      field("Town or city", { ccd: ["applicantAddress.PostTown"] }),
      field("Postcode", { ccd: ["applicantAddress.PostCode"] })
    ]);

  it("should keep each row's own ids when the rows of an address share one subject", () => {
    const rows3 = rowsOf(matchCcd(address(), CASE_TYPE, { keepSet: true }));

    expect(rows3.map((r) => r.ccd)).toEqual([["applicantAddress.AddressLine1"], ["applicantAddress.PostTown"], ["applicantAddress.PostCode"]]);
    expect(rows3.map((r) => r.ccdMatch?.status)).toEqual(["new", "new", "new"]);
  });

  it("should give the rows of one subject the same group when they are decided together", () => {
    const rows3 = rowsOf(matchCcd(spec([field("First line of address", { id: "1" }), field("Town or city"), field("Phone number", { id: "2" })]), CASE_TYPE));

    expect(rows3[0]?.ccdMatch?.group).toBeDefined();
    expect(rows3[1]?.ccdMatch?.group).toBe(rows3[0]?.ccdMatch?.group);
    expect(rows3[2]?.ccdMatch?.group).toBeUndefined();
  });

  it("should map only the rows that carry an id, and leave the others with no status and no proposal, when asked to", () => {
    const rows2 = rowsOf(
      matchCcd(spec([field("First name", { ccd: ["applicantFirstName"] }), field("Place of birth")]), CASE_TYPE, { keepSet: true, onlyMapped: true })
    );

    expect(rows2[0]?.ccdMatch?.status).toBe("existing");
    expect(rows2[1]?.ccdMatch).toBeUndefined();
    expect(rows2[1]?.ccd).toEqual([]);
  });
});

describe("a group with rows that have no ids of their own", () => {
  it("should decide the group's other rows afresh, not copy the kept row's decision or who chose it, when some of its rows have no ids", () => {
    const rows2 = rowsOf(
      matchCcd(spec([field("First line of address", { id: "2.2", ccd: ["applicantAddress"] }), field("Town or city")]), CASE_TYPE, { keepSet: true })
    );

    expect(rows2[0]?.ccdMatch?.chosenBy).toBe("form");
    expect(rows2[1]?.ccdMatch?.reason).toMatch(/closest field of the case type/);
    expect(rows2[1]?.ccdMatch?.chosenBy).toBeUndefined();
  });
});

describe("matching a group again against another case type", () => {
  const address = (second: Record<string, unknown>) =>
    spec([
      field("First line of address", {
        id: "2.2",
        ccd: ["chosenAddress"],
        ccdMatch: { status: "new", newField: { id: "chosenAddress", type: "AddressUK" }, chosenBy: "person" }
      }),
      field("Town or city", second)
    ]);
  const stale = { ccd: ["staleOld"], ccdMatch: { status: "new", newField: { id: "staleOld", type: "Text" } } };

  it("should decide the rows the person did not set afresh when only some rows of the group were set", () => {
    const rows2 = rowsOf(matchCcd(address(stale), CASE_TYPE, { keepSet: true }));

    expect(rows2[0]?.ccd).toEqual(["chosenAddress"]);
    expect(rows2[1]?.ccd).not.toEqual(["staleOld"]);
    expect(JSON.stringify(rows2[1]?.ccdMatch)).not.toContain("staleOld");
  });

  it("should clear a status the earlier case type left on a row with no id when only mapped rows are matched", () => {
    const rows2 = rowsOf(
      matchCcd(address({ ccdMatch: { status: "new", newField: { id: "staleOld", type: "Text" } } }), CASE_TYPE, { keepSet: true, onlyMapped: true })
    );

    expect(rows2[1]?.ccdMatch).toBeUndefined();
  });
});

describe("a row with several ids the case type lacks", () => {
  it("should record every one of them as a field to add", () => {
    const rows2 = matchCcd(spec([field("Anything", { ccd: ["missingOne", "applicantEmail", "missingTwo"] })]), CASE_TYPE, { keepSet: true });

    expect(newCcdFields(rows2).map((f) => f.id)).toEqual(["missingOne", "missingTwo"]);
  });
});

describe("a proposed id", () => {
  it.each([
    ["Applicant's full name", "applicantFullName"],
    ["Applicant’s date of birth", "applicantDateBirth"]
  ])("should drop the possessive in %s", (label, id) => {
    expect(rowsOf(matchCcd(spec([field(label)]), [ccd("zzz", "Text")]))[0]?.ccd).toEqual([id]);
  });

  it("should be a valid Java identifier when the label starts with a digit", () => {
    const [id] = rowsOf(matchCcd(spec([field("3rd party name")]), [ccd("zzz", "Text")]))[0]?.ccd ?? [];

    expect(id).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
  });
});

describe("a date in three boxes", () => {
  it("should not join the boxes when they cross sections or sit over a row that is not a field", () => {
    const day = field("Date of birth Day");
    const month = field("Month");
    const year = field("Year");
    const crossing = formSpecSchema.parse({
      form: { name: "F", formType: "F1" },
      sections: [
        { id: "1", title: "A", fields: [day, month] },
        { id: "2", title: "B", fields: [year] }
      ]
    });
    const blocked = spec([day, fieldSchema.parse({ role: "label", label: "Note" }), month, year]);

    expect(new Set(rowsOf(matchCcd(crossing, CASE_TYPE)).map((r) => r.ccdMatch?.newField?.id ?? r.ccd[0])).size).toBeGreaterThan(1);
    expect(rowsOf(matchCcd(blocked, CASE_TYPE))[0]?.ccd).not.toEqual(rowsOf(matchCcd(blocked, CASE_TYPE))[2]?.ccd);
  });
});

describe("matching again", () => {
  it("should propose the same id for a new field when matching again, not one numbered after its own earlier proposal", () => {
    const first = matchCcd(spec([field("National insurance number")]), CASE_TYPE);
    const again = matchCcd(first, CASE_TYPE, { keepSet: true });

    expect(rowsOf(again)[0]?.ccd).toEqual(rowsOf(first)[0]?.ccd);
    expect(rowsOf(again)[0]?.ccd).toEqual(["nationalInsuranceNumber"]);
  });

  it("should avoid an id when another row keeps it or the case type has it", () => {
    const rows2 = rowsOf(
      matchCcd(spec([field("Email address 2", { ccd: ["emailAddress"] }), field("Email address")]), [ccd("zzz", "Text")], { keepSet: true })
    );

    expect(rows2[1]?.ccd).not.toEqual(["emailAddress"]);
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

  it("should list each new field once with its id, FieldType and label when several rows share it", () => {
    expect(newCcdFields(matched).map((f) => [f.id, f.type, f.label])).toEqual([
      ["nationalInsuranceNumber", "Text", "National insurance number"],
      ["incidentLocation", "Text", "Incident location"]
    ]);
  });

  it("should write the list and a CaseData snippet when the service is config-generator", () => {
    const files = newCcdFieldFiles(matched);
    expect(files.map((f) => f.path)).toEqual(["new-ccd-fields.json", "new-case-data-fields.java.txt"]);
    expect(JSON.parse(files[0]?.content as string)).toMatchObject({ caseType: "T", fields: [{ id: "nationalInsuranceNumber" }, { id: "incidentLocation" }] });
    expect(files[1]?.content).toContain(
      '@CCD(\n    label = "National insurance number",\n    access = {DefaultAccess.class}\n)\nprivate String nationalInsuranceNumber;'
    );
  });

  it("should list a complex member separately and write no field for it when the id has a dot", () => {
    const withMember = matchCcd(
      spec(
        [
          field("Town", {
            ccd: ["applicantAddress.PostTown"],
            ccdMatch: { status: "new", newField: { id: "applicantAddress.PostTown", type: "Text" }, chosenBy: "form" }
          })
        ],
        "S",
        {
          ccdCaseTypeId: "T",
          ccdConfig: "config-generator"
        }
      ),
      CASE_TYPE,
      { keepSet: true }
    );
    const files = newCcdFieldFiles(withMember);

    const json = JSON.parse(files[0]?.content as string);
    expect(json.fields).toEqual([]);
    expect(json.complexMembers).toEqual([{ parent: "applicantAddress", id: "PostTown", type: "Text", label: "Town" }]);
    expect(files.map((f) => f.path)).toEqual(["new-ccd-fields.json"]);
  });

  it("should write nothing when no field is new", () => {
    expect(newCcdFieldFiles(matchCcd(spec([field("First name")]), CASE_TYPE))).toEqual([]);
  });

  it("should omit the snippet when the service is not config-generator", () => {
    const json = newCcdFieldFiles({ ...matched, form: { ...matched.form, ccdConfig: "json" } });
    expect(json.map((f) => f.path)).toEqual(["new-ccd-fields.json"]);
  });

  it("should declare every type when a new field is offered it", () => {
    for (const type of NEW_FIELD_TYPES) {
      const text = caseDataSnippet([{ id: "someField", type, label: "Some field" }]);
      expect(text, type).toContain("private ");
      expect(text, type).not.toContain("undefined");
    }
  });

  it("should write list fields as the enum the services declare when the type is a list", () => {
    const text = caseDataSnippet([
      { id: "kind", type: "FixedList", label: "Kind" },
      { id: "recipients", type: "MultiSelectList", label: "Recipients" },
      { id: "movedAt", type: "DateTime", label: "Moved at" }
    ]);
    expect(text).toContain('typeOverride = FixedList,\n    typeParameterOverride = "Kind"');
    expect(text).toContain("private Kind kind;");
    expect(text).toContain('typeOverride = MultiSelectList,\n    typeParameterOverride = "Recipients"');
    expect(text).toContain("private Set<Recipients> recipients;");
    expect(text).toContain("private LocalDateTime movedAt;");
  });

  it("should give a date and a list field their Java types and overrides when the snippet is written", () => {
    const text = caseDataSnippet([
      { id: "movedIn", type: "Date", label: "Moved in" },
      { id: "kind", type: "FixedRadioList", label: "Kind" }
    ]);
    expect(text).toContain("private LocalDate movedIn;");
    expect(text).toContain("private Kind kind;");
  });
});
