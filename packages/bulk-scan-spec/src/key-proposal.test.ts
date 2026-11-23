import { describe, expect, it } from "vitest";
import { camelCase, proposeKeys, subjectOf } from "./key-proposal.ts";

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

describe("camelCase of options", () => {
  it("should spell a No option as no, not number", () => {
    expect(["Yes", "No", "Not sure"].map((l) => camelCase(l))).toEqual(["yes", "no", "notSure"]);
  });

  it("should leave out leading words the prefix already says", () => {
    expect(camelCase("Applicant is habitually resident", new Set(["sole", "applicant", "applicant1"]))).toBe("habituallyResident");
    expect(camelCase("Applicant", new Set(["applicant"]))).toBe("");
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

describe("a repeated label in a later section", () => {
  const slot = (section: string) => ({ label: "First name", context: section, section });

  it("should lead the key with the section's subject when an earlier section has the key", () => {
    const keys = proposeKeys(
      [
        slot("Section 2 – Your information"),
        slot("Section 3 – Appealing on behalf of a minor (under 18 years old)"),
        slot("Section 5 – Appellant's representative information")
      ],
      [],
      ["Q2_1", "Q3_1", "Q5_2"]
    );
    expect(keys.map((k) => k.key)).toEqual(["firstName", "minorFirstName", "representativeFirstName"]);
  });

  it("should suffix the question's tag when the section has no subject or its subject key is taken too", () => {
    const keys = proposeKeys(
      [slot("Section 2"), slot("Section 3"), slot("Section 4 – Appealing on behalf of a minor"), slot("Section 5 – Minor")],
      [],
      ["Q2", "Q3", "Q4", "Q5"]
    );
    expect(keys.map((k) => k.key)).toEqual(["firstName", "firstNameQ3", "minorFirstName", "minorFirstNameQ5"]);
  });
});

describe("a repeated label whose short forms are all taken", () => {
  it("should keep the section's subject in the numbered form when the suffixed key is taken too", () => {
    const minor = "Section 3 – Appealing on behalf of a minor";
    const keys = proposeKeys(
      [
        { label: "First name", context: "", section: "Section 2" },
        { label: "First name", context: "", section: minor },
        { label: "First name", context: "", section: minor },
        { label: "First name", context: "", section: minor }
      ],
      [],
      ["Q3", "Q3", "Q3", "Q3"]
    );
    expect(keys.map((k) => k.key)).toEqual(["firstName", "minorFirstName", "minorFirstNameQ3", "minorFirstNameQ32"]);
  });
});

describe("a date's keys", () => {
  const date = { label: "Date of birth", context: "", parts: ["Day", "Month", "Year"] } as const;

  it("should take the house's own three keys when they all exist", () => {
    const house = ["soleOrApplicant1DateOfBirthDay", "soleOrApplicant1DateOfBirthMonth", "soleOrApplicant1DateOfBirthYear"];
    const [one] = proposeKeys([{ ...date, context: "soleOrApplicant1" }], house, ["Q1"]);
    expect(one?.parts?.map((k) => k.key)).toEqual(house);
    expect(one?.reason).toBe(`matches existing keys ${house.join(", ")}`);
  });

  it("should strip a trailing Day, Month or Year from a reused key before adding the parts when the house lacks the other two", () => {
    const [one] = proposeKeys([date], ["dateOfBirthDay"], ["Q1"]);
    expect(one?.parts?.map((k) => k.key)).toEqual(["dateOfBirthDay", "dateOfBirthMonth", "dateOfBirthYear"]);
    expect(one?.reason).toContain("dateOfBirthDay, dateOfBirthMonth, dateOfBirthYear");
  });

  it("should name every key the date carries in its reason when the keys are new", () => {
    const [one] = proposeKeys([date], [], ["Q1"]);
    expect(one?.parts?.map((k) => k.key)).toEqual(["dateBirthDay", "dateBirthMonth", "dateBirthYear"]);
    expect(one?.reason).toBe("keys dateBirthDay, dateBirthMonth, dateBirthYear: new from the label with Day, Month, Year");
  });

  it("should keep another slot off a date's keys when the date's parts are reserved", () => {
    const keys = proposeKeys([date, { label: "Date birth day", context: "" }], [], ["Q1", "Q2"]);
    expect(keys[0]?.parts?.map((k) => k.key)).toEqual(["dateBirthDay", "dateBirthMonth", "dateBirthYear"]);
    expect(keys[1]?.key).toBe("dateBirthDayQ2");
  });

  it("should move a date off keys another slot took first when it comes later", () => {
    const keys = proposeKeys([{ label: "Date birth day", context: "" }, date], [], ["Q1", "Q2"]);
    expect(keys[0]?.key).toBe("dateBirthDay");
    expect(keys[1]?.parts?.map((k) => k.key)).toEqual(["dateBirthQ2Day", "dateBirthQ2Month", "dateBirthQ2Year"]);
  });
});

describe("subjectOf", () => {
  it("should give the last word that is not generic when a title is read", () => {
    expect(subjectOf("Section 4 – Appealing following a bereavement")).toBe("bereavement");
    expect(subjectOf("Section 1 – Appeal information")).toBeUndefined();
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

  it("should not repeat the party when the label starts with it", () => {
    const [key] = proposeKeys([{ label: "Respondent is habitually resident", context: "Section 3 - About the respondent or applicant 2" }], HOUSE, [""]);
    expect(key?.key).toBe("respondentOrApplicant2HabituallyResident");
  });

  it("should leave a new key unprefixed when no house prefix is named in its context", () => {
    const [key] = proposeKeys([{ label: "Postcode", context: "Section 9" }], HOUSE, [""]);
    expect(key?.key).toBe("postcode");
  });
});
