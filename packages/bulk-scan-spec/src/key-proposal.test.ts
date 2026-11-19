import { describe, expect, it } from "vitest";
import { camelCase, proposeKeys } from "./key-proposal.ts";

const HOUSE = [
  "soleOrApplicant1FirstName",
  "soleOrApplicant1Email",
  "soleOrApplicant1PhoneNo",
  "respondentOrApplicant2Email",
  "respondentOrApplicant2PhoneNo",
  "respondentOrApplicant2FirstName",
  "applicationForDivorce"
];

describe("camelCase", () => {
  it("should join the first five meaningful words of a label", () => {
    expect(camelCase("Town or city (optional)")).toBe("townCity");
    expect(camelCase("Enter the building and street of the address of the solicitor")).toBe("enterBuildingStreetAddressSolicitor");
  });
});

describe("proposeKeys without house style", () => {
  it("should use the label in camelCase and mark it low confidence", () => {
    const [key] = proposeKeys([{ label: "Court name", context: "Section 2" }], [], ["Q2_2"]);
    expect(key).toMatchObject({ key: "courtName", confidence: "low" });
  });

  it("should tell a repeated label apart by its question tag", () => {
    const keys = proposeKeys(
      [
        { label: "Country", context: "" },
        { label: "Country", context: "" }
      ],
      [],
      ["Q2_3", "Q3_3"]
    );
    expect(keys.map((k) => k.key)).toEqual(["country", "countryQ3_3"]);
  });
});

describe("proposeKeys with house style", () => {
  it("should reuse the existing key for the party and label in context", () => {
    const keys = proposeKeys(
      [
        { label: "Email (if you have one)", context: "Section 2 - About you (the sole applicant or applicant 1)" },
        { label: "Email", context: "Section 3 - About the respondent or applicant 2" },
        { label: "Phone no.", context: "Section 3 - About the respondent or applicant 2" }
      ],
      HOUSE,
      ["", "", ""]
    );
    expect(keys.map((k) => k.key)).toEqual(["soleOrApplicant1Email", "respondentOrApplicant2Email", "respondentOrApplicant2PhoneNo"]);
    expect(keys[0]?.reason).toContain("matches existing key");
  });

  it("should give an existing key to one slot only", () => {
    const keys = proposeKeys(
      [
        { label: "Email", context: "applicant 1" },
        { label: "Email", context: "applicant 1" }
      ],
      HOUSE,
      ["a", "b"]
    );
    expect(keys.filter((k) => k.key === "soleOrApplicant1Email")).toHaveLength(1);
  });

  it("should lead a new key with the house prefix whose party the context names", () => {
    const [key] = proposeKeys([{ label: "Postcode", context: "Section 3 - About the respondent or applicant 2" }], HOUSE, [""]);
    expect(key).toMatchObject({ key: "respondentOrApplicant2Postcode", confidence: "low" });
    expect(key?.reason).toContain("house prefix respondentOrApplicant2");
  });

  it("should leave a new key unprefixed when no house prefix is named in its context", () => {
    const [key] = proposeKeys([{ label: "Postcode", context: "Section 9" }], HOUSE, [""]);
    expect(key?.key).toBe("postcode");
  });
});
