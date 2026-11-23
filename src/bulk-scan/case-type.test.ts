import { type FormSpec, fieldSchema, formSpecSchema } from "@hmcts-cft/bulk-scan-spec";
import { newCcdFields } from "@hmcts-cft/bulk-scan-spec/ccd-match";
import { describe, expect, it } from "vitest";
import { ccdCounts, chooseCandidate, chooseNew, editNewField, withCaseType, withoutCaseType } from "./case-type.ts";
import { patchField, reviewChecklist } from "./edit.ts";

const field = (label: string, extra: Record<string, unknown> = {}) => fieldSchema.parse({ label, keys: [label.replace(/\W/g, "")], ...extra });
const spec = (...fields: ReturnType<typeof field>[]): FormSpec =>
  formSpecSchema.parse({ form: { name: "F", formType: "F1" }, sections: [{ id: "1", title: "Your details", fields }] });
const rows = (s: FormSpec) => s.sections.flatMap((section) => section.fields);

const FIELDS = [
  { id: "applicantEmail", label: "Email address", type: "Email" },
  { id: "applicantEmailTwo", label: "Email address", type: "Email" },
  { id: "applicantFirstName", label: "First name", type: "Text" }
];
const CHOICE = { product: "nfdiv", caseType: "NFD", config: "config-generator" } as const;

describe("withCaseType", () => {
  it("should set the header and match each field against the case type's fields", () => {
    const result = withCaseType(spec(field("First name"), field("Email address"), field("Place of birth")), CHOICE, FIELDS);

    expect(result.form).toMatchObject({ ccdCaseTypeId: "NFD", ccdProduct: "nfdiv", ccdConfig: "config-generator" });
    expect(rows(result).map((f) => f.ccdMatch?.status)).toEqual(["existing", "unsure", "new"]);
  });

  it("should leave a CCD id the person set alone and only refresh its status against the new case type", () => {
    const set = field("Anything", {
      ccd: ["applicantEmail"],
      ccdMatch: { status: "new", newField: { id: "applicantEmail", type: "Text" }, chosenBy: "person" }
    });
    const result = withCaseType(spec(set), CHOICE, FIELDS);

    expect(rows(result)[0]).toMatchObject({ ccd: ["applicantEmail"], ccdMatch: { status: "existing" } });
  });

  it("should match again the ids the matcher proposed and keep the ones the person chose, when the case type changes", () => {
    const first = withCaseType(spec(field("First name"), field("Email address"), field("Place of birth")), CHOICE, FIELDS);
    const chosen = chooseCandidate(first, 0, 1, "applicantEmailTwo");
    const other = [
      { id: "firstName", label: "First name", type: "Text" },
      { id: "applicantEmailTwo", label: "Email address", type: "Email" },
      { id: "placeOfBirth", label: "Place of birth", type: "Text" }
    ];

    const result = rows(withCaseType(chosen, { product: "pcs", caseType: "PCS" }, other));

    expect(result.map((f) => f.ccd)).toEqual([["firstName"], ["applicantEmailTwo"], ["placeOfBirth"]]);
    expect(result[1]?.ccdMatch).toEqual({ status: "existing", chosenBy: "person" });
    expect(result[0]?.ccdMatch).not.toHaveProperty("chosenBy");
  });

  it("should drop the review entries about CCD ids that the earlier case type left", () => {
    const withReview = spec(
      field("First name", {
        review: [
          { about: "ccd", reason: "x", confidence: "low" },
          { about: "key", reason: "y", confidence: "low" }
        ]
      })
    );

    expect(rows(withCaseType(withReview, CHOICE, FIELDS))[0]?.review).toEqual([{ about: "key", reason: "y", confidence: "low" }]);
  });

  it("should drop the configuration of the case type it replaces when the new one has none", () => {
    const first = withCaseType(spec(field("First name")), CHOICE, FIELDS);

    expect(withCaseType(first, { product: "pcs", caseType: "PCS" }, FIELDS).form.ccdConfig).toBeUndefined();
  });
});

describe("withoutCaseType", () => {
  it("should keep an id that came with the form, through a pick and through no case type", () => {
    const sheet = spec(field("First name", { ccd: ["sheetId"] }));

    const picked = withCaseType(sheet, CHOICE, FIELDS);
    expect(rows(picked)[0]).toMatchObject({ ccd: ["sheetId"], ccdMatch: { status: "new", chosenBy: "form" } });
    expect(rows(withCaseType(picked, { product: "pcs", caseType: "PCS" }, FIELDS))[0]?.ccd).toEqual(["sheetId"]);
    expect(rows(withoutCaseType(picked))[0]?.ccd).toEqual(["sheetId"]);
  });

  it("should clear the ids the matcher proposed and keep the ones the person chose, so a later pick does not take them for the person's", () => {
    const matched = withCaseType(spec(field("First name"), field("Email address")), CHOICE, FIELDS);
    const chosen = chooseCandidate(matched, 0, 1, "applicantEmailTwo");

    const result = rows(withoutCaseType(chosen));

    expect(result.map((f) => f.ccd)).toEqual([[], ["applicantEmailTwo"]]);
  });

  it("should clear the header and every status", () => {
    const result = withoutCaseType(withCaseType(spec(field("First name")), CHOICE, FIELDS));

    expect(result.form.ccdCaseTypeId).toBeUndefined();
    expect(result.form.ccdProduct).toBeUndefined();
    expect(rows(result)[0]).not.toHaveProperty("ccdMatch");
  });
});

describe("deciding an unsure row", () => {
  const unsure = () => withCaseType(spec(field("Email address")), CHOICE, FIELDS);

  it("should make the chosen candidate an existing field", () => {
    expect(rows(chooseCandidate(unsure(), 0, 0, "applicantEmailTwo"))[0]).toMatchObject({ ccd: ["applicantEmailTwo"], ccdMatch: { status: "existing" } });
  });

  it("should make it a new field with the id and type proposed for it", () => {
    expect(rows(chooseNew(unsure(), 0, 0))[0]).toMatchObject({
      ccd: ["emailAddress"],
      ccdMatch: { status: "new", newField: { id: "emailAddress", type: "Email" } }
    });
  });

  it("should take typing a CCD id in the row as choosing it", () => {
    const typed = patchField(unsure(), 0, 0, { ccd: ["applicantEmail"] });

    expect(rows(typed)[0]?.ccdMatch).toEqual({ status: "existing", chosenBy: "person" });
  });

  it("should make a typed id that the case type does not list a new field, so it is written to the list of fields to add", () => {
    const typed = patchField(unsure(), 0, 0, { ccd: ["brandNewEmail"] });

    expect(rows(typed)[0]).toMatchObject({
      ccd: ["brandNewEmail"],
      ccdMatch: { status: "new", newField: { id: "brandNewEmail", type: "Email" }, chosenBy: "person" }
    });
    expect(newCcdFields(typed).map((f) => f.id)).toEqual(["brandNewEmail"]);
  });

  it("should name the new field after the typed id the case type lacks, not the first typed", () => {
    const typed = patchField(unsure(), 0, 0, { ccd: ["applicantEmail", "brandNewEmail"] });

    expect(rows(typed)[0]?.ccdMatch).toMatchObject({ status: "new", newField: { id: "brandNewEmail" } });
  });

  it("should apply a choice to every row of an address, which share one decision", () => {
    const address = spec(field("First line of address", { id: "2.2" }), field("Town or city"), field("Postcode"));
    const matched = withCaseType(address, CHOICE, [
      { id: "homeAddress", label: "Address", type: "AddressUK" },
      { id: "workAddress", label: "Address", type: "AddressUK" }
    ]);

    expect(rows(chooseCandidate(matched, 0, 1, "workAddress")).map((f) => f.ccd)).toEqual([["workAddress"], ["workAddress"], ["workAddress"]]);
  });
});

describe("a new field", () => {
  const added = () => withCaseType(spec(field("Place of birth")), CHOICE, FIELDS);

  it("should have its id and FieldType edited, and its row follow", () => {
    const edited = editNewField(editNewField(added(), 0, 0, { id: "birthPlace" }), 0, 0, { type: "TextArea" });

    expect(rows(edited)[0]).toMatchObject({ ccd: ["birthPlace"], ccdMatch: { newField: { id: "birthPlace", type: "TextArea" } } });
  });

  it("should follow an id typed in the row", () => {
    expect(rows(patchField(added(), 0, 0, { ccd: ["typedId"] }))[0]?.ccdMatch?.newField?.id).toBe("typedId");
  });

  it("should lose its status when the id is cleared", () => {
    expect(rows(patchField(added(), 0, 0, { ccd: [] }))[0]).not.toHaveProperty("ccdMatch");
  });

  it("should leave an existing row alone when asked to edit it as new", () => {
    const existing = withCaseType(spec(field("First name")), CHOICE, FIELDS);

    expect(editNewField(existing, 0, 0, { id: "x" })).toEqual(existing);
  });
});

describe("ccdCounts and the checklist", () => {
  it("should count the new fields and the rows still to choose", () => {
    const matched = withCaseType(spec(field("Email address"), field("Place of birth"), field("First name")), CHOICE, FIELDS);

    expect(ccdCounts(matched)).toEqual({ newFields: 1, unsure: 1 });
  });

  it("should list an unsure row as something to resolve until it is decided", () => {
    const matched = withCaseType(spec(field("Email address")), CHOICE, FIELDS);

    expect(reviewChecklist(matched)).toMatchObject([{ about: "ccd", unresolved: true, confidence: "low" }]);
    expect(reviewChecklist(chooseNew(matched, 0, 0))).toEqual([]);
  });
});
