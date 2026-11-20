import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { spec as sp3, spec } from "../__fixtures__/helpers.ts";
import { fisFormYaml, fisTransformYaml } from "../codegen/fis.ts";
import { sscsSchema } from "../codegen/sscs.ts";
import { fisFormYaml as ffy } from "./fis.ts";

describe("fis and SSCS output", () => {
  const transformable = [
    {
      id: "1.1",
      keys: ["aSole"],
      ccd: ["applicationType"],
      rules: [{ ref: "1", when: { aSole: true }, set: { applicationType: "soleApplication" }, outcome: "success" }]
    },
    { id: "1.2", keys: ["free"], ccd: ["freeCcd"], logicText: "something in English" },
    { id: "1.3", keys: ["name"], ccd: ["applicant1Name"], rules: [{ set: { applicant1Name: { from: "name" } } }] }
  ];

  it("should map only straight copies in the fis transform when rules exist, and list the rest as unmapped", () => {
    const { yaml, unmapped } = fisTransformYaml(spec(transformable));
    expect(yaml).toContain("applicant1Name: name");
    expect(yaml).not.toContain("applicationType:");
    expect(yaml).not.toContain("freeCcd:");
    expect(unmapped.map((u) => u.ccd).sort((a, b) => (a < b ? -1 : 1))).toEqual(["applicationType", "freeCcd"]);
  });

  it("should map a copy guarded by not-null in the fis transform when the other branch only raises a warning", () => {
    const { yaml, unmapped } = fisTransformYaml(
      spec([
        {
          id: "1.1",
          keys: ["first"],
          ccd: ["applicant1FirstName"],
          rules: [
            { ref: "1", when: { first: { not: null } }, set: { applicant1FirstName: { from: "first" } }, outcome: "success" },
            { ref: "2", otherwise: true, outcome: "warning" }
          ]
        }
      ])
    );
    expect(yaml).toContain("applicant1FirstName: first");
    expect(unmapped).toEqual([]);
  });

  it("should accept lower-case emails and postcodes in the schema and the fis form patterns when they are validated", () => {
    const s = spec([{ keys: ["applicantEmail", "applicantPostcode"] }]);
    const properties = (sscsSchema(s) as { properties: Record<string, { pattern: string }> }).properties;
    expect(new RegExp(properties.applicantEmail?.pattern ?? "").test("test@example.com")).toBe(true);
    expect(new RegExp(properties.applicantPostcode?.pattern ?? "").test("ab1 2de")).toBe(true);
    const yaml = fisFormYaml(s);
    expect(yaml).toContain("a-z");
  });
});

describe("fis format checks follow the shared format rules", () => {
  it("should check what nfdiv and the schema check when formats apply: no email or phone format on tick boxes, and date parts included", () => {
    const s = sp3([
      { keys: ["applicantEmail"] },
      { keys: ["cardPaymentPhone"], inputType: "checkbox" },
      { keys: ["birthDay", "birthYear"] },
      { keys: ["code"], regex: "^[A-Z]{3}$" }
    ]);
    const doc = parseYaml(ffy(s)) as Record<string, any>;
    const checks = doc.uk.gov.hmcts["form-validation"].caseTypeofApplication.T.regexValidationFields as Record<string, { fieldNames: string[]; regex: string }>;
    const byKey = new Map(Object.values(checks).flatMap((c) => c.fieldNames.map((k) => [k, c.regex] as const)));
    expect([...byKey.keys()].sort((a, b) => (a < b ? -1 : 1))).toEqual(["applicantEmail", "birthDay", "birthYear", "code"]);
    expect(byKey.get("birthDay")).toBe("^(?:(0?[1-9]|[12][0-9]|3[01]))$");
    expect(byKey.get("code")).toBe("^(?:[A-Z]{3})$");
  });
});

describe("fis regex buckets", () => {
  it("should keep a custom regex out of the shared bucket when a key is named like one", () => {
    const s = spec([
      { id: "1.1", keys: ["email"], regex: "[0-9]{3}" },
      { id: "1.2", keys: ["contactEmail"] },
      { id: "1.3", keys: ["other"], regex: "[a-z]{2}" }
    ]);
    const root = parseYaml(fisFormYaml(s)) as Record<string, any>;
    const buckets = root.uk.gov.hmcts["form-validation"].caseTypeofApplication.T.regexValidationFields as Record<
      string,
      { fieldNames: string[]; regex: string }
    >;
    expect(buckets.emailFields?.fieldNames).toEqual(["contactEmail"]);
    const withCustom = Object.entries(buckets).filter(([, b]) => b.fieldNames.includes("email"));
    expect(withCustom).toHaveLength(1);
    expect(withCustom[0]?.[0]).not.toBe("emailFields");
    expect(Object.keys(buckets)).toHaveLength(new Set(Object.keys(buckets)).size);
  });
});
