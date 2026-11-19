import { describe, expect, it } from "vitest";
import { fisFormKeys, fisTransformKeys, javaPojoKeys, jsonSchemaKeys } from "./code-keys.ts";
import { classifyDrift, formatDrift, sheetInternalKeys, similarity, specKeys } from "./drift.ts";
import { fieldSchema, formSpecSchema } from "./schema.ts";

describe("javaPojoKeys", () => {
  it("should take @JsonProperty as the key when it is present, skip static fields and comments, and read final fields", () => {
    const keys = javaPojoKeys(`
      @JsonIgnoreProperties(ignoreUnknown = true)
      public class Fields {
        private static final String CONSTANT = "x";
        private String plain;
        @JsonProperty("aSoleApplication")
        private String soleApplication;
        private final String finalField;
        // private String commented;
        private List<String> many = new ArrayList<>();
        private static ObjectMapper createMapper() { return null; }
      }`);
    expect(keys).toEqual([{ key: "plain" }, { key: "aSoleApplication", alias: { field: "soleApplication" } }, { key: "finalField" }, { key: "many" }]);
  });
});

describe("other service patterns", () => {
  it("should read the property names when the code is a JSON Schema", () => {
    expect(jsonSchemaKeys('{"properties": {"person1_first_name": {"type": "string"}, "mrn_date": {}}, "required": ["x"]}')).toEqual([
      { key: "person1_first_name" },
      { key: "mrn_date" }
    ]);
  });

  it("should read fis mandatory, optional and regex field names when the YAML lists them, ignoring blanks", () => {
    const yaml = `
uk:
  gov:
    hmcts:
      form-validation:
        caseTypeofApplication:
          FL401:
            mandatoryFields:
              - applicant_firstName
            optionalFields:
              - applicant_lastName
            regexValidationFields:
              phoneNumberFields:
                fieldNames:
                  - telephone_number
              faxNumberFields:
                fieldNames:
                  -
                regex:`;
    expect(fisFormKeys(yaml).map((k) => k.key)).toEqual(["applicant_firstName", "applicant_lastName", "telephone_number"]);
  });

  it("should read fis transform OCR names from the values of caseDataFields when the YAML has comments, not from the comments", () => {
    const yaml = `
uk:
  gov:
    hmcts:
      transform:
        caseTypeofApplication:
          A1:
            caseFields:
              CASE_TYPE_ID: PRLAPPS
            caseDataFields:
              applicant:
                - value:
                    applicantFullName: applicant_full_name #not in use
                    applicantAddress: applicant_address`;
    expect(fisTransformKeys(yaml).map((k) => k.key)).toEqual(["applicant_full_name", "applicant_address"]);
  });
});

describe("classifyDrift", () => {
  const code = ["alpha", "aJoint", "applicantFirstName", "applicant2HWFNo", "summaryCases", "onlyInCode"].map((key) => ({ key }));
  const spec = ["alpha", "aJoint", "ApplicantFirstName", "applicant2HWFConfirmationNo", "summaryCase", "onlyInSpec"].map((key) => ({
    key,
    readable: true,
    ids: ["1"]
  }));

  it("should separate exact, case-only, likely-renamed, spec-only and code-only keys when the spec is compared with the code", () => {
    const report = classifyDrift(spec, code);
    expect(report.exact.map((m) => m.key)).toEqual(["alpha", "aJoint"]);
    expect(report.caseOnly).toEqual([{ key: "ApplicantFirstName", codeKey: "applicantFirstName" }]);
    expect(report.likelyRenamed.map((m) => [m.key, m.codeKey])).toEqual([
      ["summaryCase", "summaryCases"],
      ["applicant2HWFConfirmationNo", "applicant2HWFNo"]
    ]);
    expect(report.specOnly.map((s) => s.key)).toEqual(["onlyInSpec"]);
    expect(report.codeOnly).toEqual(["onlyInCode"]);
  });

  it("should report a key when it arrives through an alias or is used on several rows", () => {
    const report = classifyDrift(
      [
        { key: "aSole", readable: true, ids: ["1.2"] },
        { key: "dup", readable: true, ids: ["1", "2"] }
      ],
      [{ key: "aSole", alias: { field: "sole" } }, { key: "dup" }]
    );
    expect(report.viaAlias).toEqual([{ key: "aSole", codeKey: "sole" }]);
    expect(report.duplicates.map((d) => d.key)).toEqual(["dup"]);
  });

  it("should not call a key renamed when its words barely overlap", () => {
    const report = classifyDrift([{ key: "completelyDifferent", readable: true, ids: [] }], [{ key: "unrelatedKey" }]);
    expect(report.likelyRenamed).toEqual([]);
    expect(report.specOnly).toHaveLength(1);
    expect(report.codeOnly).toEqual(["unrelatedKey"]);
  });

  it("should not match two spec keys to the same code key when they differ only in case", () => {
    const report = classifyDrift(
      ["Abc", "ABC"].map((key) => ({ key, readable: true, ids: [] })),
      [{ key: "abc" }]
    );
    expect(report.caseOnly).toHaveLength(1);
    expect(report.specOnly).toHaveLength(1);
  });

  it("should print a line per difference when the drift is formatted", () => {
    const text = formatDrift(classifyDrift(spec, code), { spec: "s", code: "c" });
    expect(text).toContain("exact 2 (0 via @JsonProperty), case-only 1, likely-renamed 2, spec-only 1, code-only 1");
    expect(text).toContain("case-only   ApplicantFirstName -> applicantFirstName");
    expect(text).toContain("code-only   onlyInCode");
  });
});

describe("specKeys", () => {
  it("should list each key once with the ids of its rows when it appears on several, and whether the sheet reads it", () => {
    const spec = formSpecSchema.parse({
      form: {},
      sections: [
        {
          id: "1",
          title: "",
          fields: [
            fieldSchema.parse({ id: "1.1", keys: ["a", "b"] }),
            fieldSchema.parse({ id: "1.2", keys: ["a"] }),
            fieldSchema.parse({ id: "1.3", keys: ["heading"], mandatory: "not-read", role: "label" })
          ]
        }
      ]
    });
    expect(specKeys(spec)).toEqual([
      { key: "a", readable: true, ids: ["1.1", "1.2"] },
      { key: "b", readable: true, ids: ["1.1"] },
      { key: "heading", readable: false, ids: ["1.3"] }
    ]);
  });
});

describe("similarity", () => {
  it("should ignore case and a trailing plural s when scoring a rename, and score disjoint words as zero", () => {
    expect(similarity("summaryOfCase", "summaryOfCases")).toBe(1);
    expect(similarity("abc", "xyz")).toBe(0);
  });
});

describe("sheet-internal drift", () => {
  it("should report keys the Description and Tag columns disagree on when the sheet is compared, and explain a code-only key the sheet describes", () => {
    const spec = formSpecSchema.parse({
      form: {},
      sections: [{ id: "1", title: "", fields: [fieldSchema.parse({ id: "2.1", keys: ["applicant1Sign"], emits: [{ key: "applicant2Sign", value: "" }] })] }]
    });
    const report = classifyDrift(specKeys(spec), [{ key: "applicant2Sign" }], sheetInternalKeys(spec));
    expect(report.sheetInternal).toEqual([
      { key: "applicant2Sign", side: "description-only", ids: ["2.1"], code: "exact" },
      { key: "applicant1Sign", side: "tag-only", ids: ["2.1"], code: "none" }
    ]);
    expect(report.codeOnlyExplained).toEqual([{ key: "applicant2Sign", ids: ["2.1"] }]);
  });
});
