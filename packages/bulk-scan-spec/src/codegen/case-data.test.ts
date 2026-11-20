import { describe, expect, it } from "vitest";
import { spec } from "../__fixtures__/helpers.ts";
import { formSpecSchema } from "../schema.ts";
import { caseDataFor } from "./case-data.ts";

describe("case data", () => {
  it("should copy a key to its CCD field and leave out a key that is blank", () => {
    const s = spec([
      { keys: ["firstName"], ccd: ["applicant1FirstName"] },
      { keys: ["lastName"], ccd: ["applicant1LastName"] }
    ]);
    expect(caseDataFor(s, { firstName: "Ada", lastName: "" })).toEqual({ applicant1FirstName: "Ada" });
  });

  it("should write the literal and the passed-through value of the rule that holds and nothing for the one that does not", () => {
    const s = spec([
      {
        keys: ["divorce", "dissolution"],
        inputType: "checkbox",
        ccd: ["divorceOrDissolution"],
        rules: [
          { ref: "1", when: { divorce: true }, set: { divorceOrDissolution: "divorce", echo: { from: "divorce" } }, outcome: "success" },
          { ref: "2", when: { dissolution: true }, set: { divorceOrDissolution: "dissolution" }, outcome: "success" }
        ]
      }
    ]);
    expect(caseDataFor(s, { divorce: "true", dissolution: "false" })).toEqual({ divorceOrDissolution: "divorce", echo: "true" });
    expect(caseDataFor(s, { divorce: "false", dissolution: "true" })).toEqual({ divorceOrDissolution: "dissolution" });
  });

  it("should compose an address from the parts that have a value", () => {
    const s = formSpecSchema.parse({
      form: { formType: "T", name: "T" },
      sections: [{ id: "1", title: "", fields: [{ keys: ["street", "town"] }] }],
      composes: [{ ccd: "homeAddress", type: "AddressUK", from: { AddressLine1: "street", PostTown: "town", County: "county" } }]
    });
    expect(caseDataFor(s, { street: "1 High St", town: "", county: "" })).toEqual({ homeAddress: { AddressLine1: "1 High St" } });
    expect(caseDataFor(s, {})).toEqual({});
  });
});
