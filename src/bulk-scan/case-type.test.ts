import { type FormSpec, fieldSchema, formSpecSchema } from "@hmcts-cft/bulk-scan-spec";
import { newCcdFields } from "@hmcts-cft/bulk-scan-spec/ccd-match";
import { describe, expect, it } from "vitest";
import { ccdCounts, chooseCandidate, chooseNew, editNewField, withCaseType, withoutCaseType } from "./case-type.ts";
import { patchField } from "./edit.ts";
import { needsReview, reviewTotal } from "./outline.ts";

const field = (label: string, extra: Record<string, unknown> = {}) => fieldSchema.parse({ label, keys: [label.replace(/\W/g, "")], ...extra });
const spec = (...fields: ReturnType<typeof field>[]): FormSpec =>
  formSpecSchema.parse({ form: { name: "F", formType: "F1", source: "pdf" }, sections: [{ id: "1", title: "Your details", fields }] });
const rows = (s: FormSpec) => s.sections.flatMap((section) => section.fields);

const FIELDS = [
  { id: "applicantEmail", label: "Email address", type: "Email" },
  { id: "applicantEmailTwo", label: "Email address", type: "Email" },
  { id: "applicantFirstName", label: "First name", type: "Text" }
];
const CHOICE = { product: "nfdiv", caseType: "NFD", config: "config-generator" } as const;

describe("withCaseType", () => {
  it("should set the header and match each field against the case type's fields when a case type is picked", () => {
    const result = withCaseType(spec(field("First name"), field("Email address"), field("Place of birth")), CHOICE, FIELDS);

    expect(result.form).toMatchObject({ ccdCaseTypeId: "NFD", ccdProduct: "nfdiv", ccdConfig: "config-generator" });
    expect(rows(result).map((f) => f.ccdMatch?.status)).toEqual(["existing", "unsure", "new"]);
  });

  it("should leave a CCD id alone and only refresh its status when the person set it", () => {
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

  it("should drop the review entries about CCD ids when an earlier case type left them", () => {
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
  it("should drop the review entries about CCD ids and the case type's field list when the case type is removed", () => {
    const matched = withCaseType(spec(field("First name")), CHOICE, FIELDS);
    const withReview = {
      ...matched,
      sections: matched.sections.map((s) => ({
        ...s,
        fields: s.fields.map((f) => ({ ...f, review: [{ about: "ccd" as const, reason: "x", confidence: "low" as const }] }))
      }))
    };
    const result = withoutCaseType(withReview);

    expect(rows(result)[0]?.review).toBeUndefined();
    expect(result.form.ccdFieldIds).toBeUndefined();
  });

  it("should keep an id through a pick and through no case type when it came with the form", () => {
    const sheet = spec(field("First name", { ccd: ["sheetId"] }));

    const picked = withCaseType(sheet, CHOICE, FIELDS);
    expect(rows(picked)[0]).toMatchObject({ ccd: ["sheetId"], ccdMatch: { status: "new", chosenBy: "form" } });
    expect(rows(withCaseType(picked, { product: "pcs", caseType: "PCS" }, FIELDS))[0]?.ccd).toEqual(["sheetId"]);
    expect(rows(withoutCaseType(picked))[0]?.ccd).toEqual(["sheetId"]);
  });

  it("should clear the ids the matcher proposed and keep the ones the person chose when the case type is removed", () => {
    const matched = withCaseType(spec(field("First name"), field("Email address")), CHOICE, FIELDS);
    const chosen = chooseCandidate(matched, 0, 1, "applicantEmailTwo");

    const result = rows(withoutCaseType(chosen));

    expect(result.map((f) => f.ccd)).toEqual([[], ["applicantEmailTwo"]]);
  });

  it("should clear the header and every status when the case type is removed", () => {
    const result = withoutCaseType(withCaseType(spec(field("First name")), CHOICE, FIELDS));

    expect(result.form.ccdCaseTypeId).toBeUndefined();
    expect(result.form.ccdProduct).toBeUndefined();
    expect(rows(result)[0]).not.toHaveProperty("ccdMatch");
  });
});

describe("a form that came from a sheet", () => {
  const sheet = (source: "sip" | "sheet" | "pdf") => {
    const base = spec(field("First name", { ccd: ["applicantFirstName"] }), field("Place of birth"));
    return { ...base, form: { ...base.form, source } };
  };

  it.each(["sip", "sheet"] as const)("should leave the rows the %s left unmapped without a proposal when a case type is picked", (source) => {
    expect(rows(withCaseType(sheet(source), CHOICE, FIELDS))[1]?.ccdMatch).toBeUndefined();
  });

  it("should leave the rows unmapped when the form was saved before it recorded where it came from", () => {
    const old = sheet("sheet");
    const { source: _source, ...form } = old.form;

    expect(rows(withCaseType({ ...old, form }, CHOICE, FIELDS))[1]?.ccdMatch).toBeUndefined();
  });

  it("should propose for a row with no id when the form came from a PDF", () => {
    expect(rows(withCaseType(sheet("pdf"), CHOICE, FIELDS))[1]?.ccdMatch?.status).toBe("new");
  });
});

describe("the case type's field ids", () => {
  it("should be kept compactly in the header, and checked against when an id is typed", () => {
    const matched = withCaseType(spec(field("Place of birth")), CHOICE, [...FIELDS, { id: "realField", label: "", type: "Text" }]);

    expect(matched.form.ccdFieldIds).toEqual(["applicantEmail", "applicantEmailTwo", "applicantFirstName", "realField"]);
    expect(rows(patchField(matched, 0, 0, { ccd: ["realField"] }))[0]?.ccdMatch).toMatchObject({ status: "existing" });
    expect(rows(patchField(matched, 0, 0, { ccd: ["madeUp"] }))[0]?.ccdMatch).toMatchObject({ status: "new", newField: { id: "madeUp" } });
  });

  it("should leave rows with no id unmapped when only mapped rows are matched", () => {
    const result = withCaseType(spec(field("First name", { ccd: ["applicantFirstName"] }), field("Place of birth")), CHOICE, FIELDS, { onlyMapped: true });

    expect(rows(result)[1]?.ccdMatch).toBeUndefined();
  });
});

describe("an id typed into a row the case type left unmapped", () => {
  const unmapped = () =>
    withCaseType(spec(field("First name", { ccd: ["applicantFirstName"] }), field("Place of birth")), CHOICE, FIELDS, { onlyMapped: true });

  it("should be an existing field when the case type lists it and a new field when it does not", () => {
    expect(rows(patchField(unmapped(), 0, 1, { ccd: ["applicantEmail"] }))[1]?.ccdMatch).toMatchObject({ status: "existing", chosenBy: "person" });
    expect(rows(patchField(unmapped(), 0, 1, { ccd: ["madeUp"] }))[1]?.ccdMatch).toMatchObject({ status: "new", newField: { id: "madeUp" } });
  });

  it("should get no status when no case type is picked", () => {
    expect(rows(patchField(spec(field("Place of birth")), 0, 0, { ccd: ["madeUp"] }))[0]).not.toHaveProperty("ccdMatch");
  });
});

describe("editing a new field's id", () => {
  it("should make it an existing field when the id is one the case type has", () => {
    const added = withCaseType(spec(field("Place of birth")), CHOICE, FIELDS);

    expect(rows(editNewField(added, 0, 0, { id: "applicantEmail" }))[0]).toMatchObject({
      ccd: ["applicantEmail"],
      ccdMatch: { status: "existing", chosenBy: "person" }
    });
  });
});

describe("deciding an unsure row", () => {
  const unsure = () => withCaseType(spec(field("Email address")), CHOICE, FIELDS);

  it("should make the chosen candidate an existing field when the person picks it", () => {
    expect(rows(chooseCandidate(unsure(), 0, 0, "applicantEmailTwo"))[0]).toMatchObject({ ccd: ["applicantEmailTwo"], ccdMatch: { status: "existing" } });
  });

  it("should make it a new field with the id and type proposed for it when the person chooses new", () => {
    expect(rows(chooseNew(unsure(), 0, 0))[0]).toMatchObject({
      ccd: ["emailAddress"],
      ccdMatch: { status: "new", newField: { id: "emailAddress", type: "Email" } }
    });
  });

  it("should take the typed id as the choice when the row was unsure", () => {
    const typed = patchField(unsure(), 0, 0, { ccd: ["applicantEmail"] });

    expect(rows(typed)[0]?.ccdMatch).toEqual({ status: "existing", chosenBy: "person" });
  });

  it("should make the typed id a new field when the case type does not list it", () => {
    const typed = patchField(unsure(), 0, 0, { ccd: ["brandNewEmail"] });

    expect(rows(typed)[0]).toMatchObject({
      ccd: ["brandNewEmail"],
      ccdMatch: { status: "new", newField: { id: "brandNewEmail", type: "Email" }, chosenBy: "person" }
    });
    expect(newCcdFields(typed).map((f) => f.id)).toEqual(["brandNewEmail"]);
  });

  it("should name the new field after the typed id the case type lacks when several are typed", () => {
    const typed = patchField(unsure(), 0, 0, { ccd: ["applicantEmail", "brandNewEmail"] });

    expect(rows(typed)[0]?.ccdMatch).toMatchObject({ status: "new", newField: { id: "brandNewEmail" } });
  });

  it("should keep a group together when one of its rows is edited", () => {
    const address = spec(field("First line of address", { id: "2.2" }), field("Town or city"), field("Postcode"));
    const matched = withCaseType(address, CHOICE, [{ id: "zzz", label: "", type: "Text" }]);
    const once = editNewField(matched, 0, 1, { id: "homeAddress" });
    const twice = editNewField(once, 0, 2, { type: "AddressGlobalUK" });

    expect(rows(twice).map((f) => f.ccdMatch?.newField)).toEqual(Array(3).fill({ id: "homeAddress", type: "AddressGlobalUK" }));
  });

  it("should edit only the rows that share the edited row's proposal when the group has rows with their own ids", () => {
    const sheet = spec(
      field("First line of address", { id: "2.2", ccd: ["applicantAddress.AddressLine1"] }),
      field("Town or city", { ccd: ["applicantAddress.PostTown"] }),
      field("Postcode", { ccd: ["applicantAddress.PostCode"] })
    );
    const matched = withCaseType(sheet, CHOICE, [{ id: "zzz", label: "", type: "Text" }]);

    const edited = editNewField(matched, 0, 1, { type: "TextArea" });

    expect(rows(edited).map((f) => f.ccdMatch?.newField?.type)).toEqual(["AddressUK", "TextArea", "AddressUK"]);
  });

  it("should give a typed id the type the row suggests and keep its group when the case type does not list it", () => {
    const address = withCaseType(spec(field("First line of address", { id: "2.2" }), field("Town or city")), CHOICE, [{ id: "zzz", label: "", type: "Text" }]);
    const date = withCaseType(spec(field("Date moved in", { inputType: "date" })), CHOICE, [{ id: "zzz", label: "", type: "Text" }]);

    const typedAddress = rows(patchField(address, 0, 0, { ccd: ["homeAddress"] }));
    const typedDate = rows(patchField(date, 0, 0, { ccd: ["movedIn"] }));

    expect(typedAddress[0]?.ccdMatch).toMatchObject({ status: "new", newField: { id: "homeAddress", type: "AddressUK" }, group: expect.any(String) });
    expect(typedDate[0]?.ccdMatch?.newField?.type).toBe("Date");
  });

  it("should apply a choice to every row of an address when they share one decision", () => {
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

  it("should follow its id and FieldType when a new field is edited", () => {
    const edited = editNewField(editNewField(added(), 0, 0, { id: "birthPlace" }), 0, 0, { type: "TextArea" });

    expect(rows(edited)[0]).toMatchObject({ ccd: ["birthPlace"], ccdMatch: { newField: { id: "birthPlace", type: "TextArea" } } });
  });

  it("should follow the id when it is typed in the row", () => {
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
  it("should count the new fields and the rows still to choose when rows are matched", () => {
    const matched = withCaseType(spec(field("Email address"), field("Place of birth"), field("First name")), CHOICE, FIELDS);

    expect(ccdCounts(matched)).toEqual({ newFields: 1, unsure: 1 });
  });

  it("should list an unsure row as something to resolve when it is undecided", () => {
    const matched = withCaseType(spec(field("Email address")), CHOICE, FIELDS);

    expect(reviewTotal(matched)).toBe(1);
    expect(needsReview(rows(matched)[0] as never)).toBe(true);
    expect(reviewTotal(chooseNew(matched, 0, 0))).toBe(0);
  });
});
