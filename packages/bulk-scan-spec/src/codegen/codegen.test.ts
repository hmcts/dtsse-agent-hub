import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildMiniD8 } from "../__fixtures__/d8-mini.ts";
import { javaPojoKeys } from "../code-keys.ts";
import type { FormSpec } from "../schema.ts";
import { allFields, fieldSchema, formSpecSchema } from "../schema.ts";
import { importTransformSheet } from "../transform-import.ts";
import { envelopeFiles, exelaEnvelope } from "./envelopes.ts";
import { fisFormYaml, fisTransformYaml } from "./fis.ts";
import { generateTarget, TARGETS } from "./index.ts";
import { javaField, nfdivFiles, probateFiles } from "./java.ts";
import { evaluateRules, keyModels, mandatoryGroups, resolveRef } from "./model.ts";
import { surnameMappingYaml } from "./orchestrator.ts";
import { scenarios, validData } from "./scenarios.ts";
import { sscsSchema } from "./sscs.ts";

function mini(): FormSpec {
  const sheet = buildMiniD8().worksheets[0];
  if (!sheet) {
    throw new Error("no sheet");
  }
  const { spec } = importTransformSheet(sheet);
  spec.form.ccdCaseTypeId = "NFD";
  spec.form.ccdEventId = "create-case";
  return spec;
}

const JAVA = { basePackage: "uk.gov.example.bulkscan", classPrefix: "X1" };

describe("key models and rules", () => {
  it("should treat a mandatory group as one requirement across its keys when it has several keys, rather than a requirement on each", () => {
    const spec = mini();
    expect(keyModels(spec).find((k) => k.key === "applicationForDivorce")?.mandatory).toBe(false);
    expect(mandatoryGroups(spec)).toEqual([{ fieldId: "1.1", keys: ["applicationForDivorce", "applicationForDissolution"] }]);
  });

  it("should decide a field's rules from the data, and refuse when a branch carries English", () => {
    const spec = mini();
    const field = allFields(spec).find((f) => f.id === "1.1");
    if (!field) {
      throw new Error("no field");
    }
    expect(evaluateRules(spec, field, { applicationForDivorce: "true" })).toMatchObject({
      ref: "1",
      outcome: "success",
      set: { divorceOrDissolution: "divorce" }
    });
    expect(evaluateRules(spec, field, { applicationForDivorce: "false", applicationForDissolution: "TRUE" })).toMatchObject({
      ref: "2",
      set: { divorceOrDissolution: "dissolution" }
    });
    expect(evaluateRules(spec, field, {})).toMatchObject({ ref: "3", outcome: "warning" });
    const english = fieldSchema.parse({ keys: ["a"], rules: [{ when: { a: "x" }, action: "something in English", outcome: "success" }] });
    expect(evaluateRules(spec, english, { a: "x" })).toBeUndefined();
  });

  it("should resolve a sheet id to the keys and values it stands for when a condition names it", () => {
    const spec = mini();
    expect(resolveRef(spec, "2.1", "Ann")).toEqual({ applicantFirstName: "Ann" });
    expect(resolveRef(spec, "1.1", "dissolution")).toEqual({ applicationForDissolution: true });
    expect(resolveRef(spec, "9.9", "x")).toBeUndefined();
  });
});

describe("scenarios and envelopes", () => {
  it("should give a valid submission that satisfies the sheet's rules and the mandatory group when the data is built", () => {
    const spec = mini();
    const data = validData(spec);
    expect(data.applicationForDivorce).toBe("true");
    expect(data.applicationForDissolution).toBe("false");
    const [first] = scenarios(spec);
    expect(first).toMatchObject({ name: "valid", kind: "valid", expected: { validation: "success" } });
  });

  it("should add a scenario for each mandatory key or group, XoR branch and allowed value when scenarios are built, each with an expectation from the rules", () => {
    const list = scenarios(mini());
    const byName = new Map(list.map((s) => [s.name, s]));
    expect(byName.get("missing-applicantFirstName")?.data.applicantFirstName).toBe("");
    expect(byName.get("missing-group-1.1")?.expected.validation).toBe("warning");
    expect(byName.get("xor-1.1-applicationForDissolution")?.data).toMatchObject({ applicationForDivorce: "false", applicationForDissolution: "true" });
    expect(byName.get("xor-1.1-none-blank")?.data).toMatchObject({ applicationForDivorce: "", applicationForDissolution: "" });
    expect(byName.get("xor-1.1-none")?.expected.validation).toBe("warning");
    expect(byName.get("xor-1.1-all")?.data).toMatchObject({ applicationForDivorce: "true", applicationForDissolution: "true" });
    expect(list.every((s) => s.expected.basis.length > 0)).toBe(true);
  });

  it("should break a date part and an email when building invalid-format scenarios, and not invent a format for free text", () => {
    const spec = formSpecSchema.parse({
      form: {},
      sections: [
        {
          id: "1",
          title: "",
          fields: [
            fieldSchema.parse({ keys: ["applicantEmail"] }),
            fieldSchema.parse({ keys: ["noteDay"], inputType: "date" }),
            fieldSchema.parse({ keys: ["notes"] })
          ]
        }
      ]
    });
    const names = scenarios(spec)
      .filter((s) => s.kind === "invalid-format")
      .map((s) => s.name);
    expect(names).toEqual(["invalid-applicantEmail", "invalid-noteDay"]);
  });

  it("should write each scenario as a validate-ocr body, a Metadata_file and an Exela envelope when envelopes are generated, with OCR that decodes back", () => {
    const spec = mini();
    const files = new Map(envelopeFiles(spec, { jurisdiction: "DIVORCE" }).map((f) => [f.path, f.content]));
    const body = JSON.parse(files.get("validate-ocr/valid.json") ?? "{}") as { ocr_data_fields: { name: string; value: string }[] };
    expect(body.ocr_data_fields.find((f) => f.name === "applicationForDivorce")).toEqual({ name: "applicationForDivorce", value: "true" });
    const metadata = JSON.parse(files.get("metadata-file/valid.json") ?? "{}") as { Metadata_file: { metadata_field_name: string }[] };
    expect(metadata.Metadata_file.map((m) => m.metadata_field_name)).toContain("applicantFirstName");
    const envelope = JSON.parse(files.get("exela/valid/metadata.json") ?? "{}") as {
      jurisdiction: string;
      scannable_items: { document_sub_type: string; ocr_data: string }[];
    };
    expect(envelope.jurisdiction).toBe("DIVORCE");
    expect(envelope.scannable_items[0]?.document_sub_type).toBe("X1");
    expect(JSON.parse(Buffer.from(envelope.scannable_items[0]?.ocr_data ?? "", "base64").toString())).toEqual(metadata);
    expect(JSON.parse(files.get("manifest.json") ?? "[]")).toHaveLength(scenarios(spec).length);
    expect(exelaEnvelope(spec, scenarios(spec)[0] as never)).toMatchObject({ envelope_classification: "new_application" });
  });
});

describe("pattern generators", () => {
  it("should write fis form YAML with mandatory, optional and format-checked keys when the fis target is generated", () => {
    const yaml = parse(fisFormYaml(mini())) as Record<string, any>;
    const form = yaml.uk.gov.hmcts["form-validation"].caseTypeofApplication.X1;
    expect(form.mandatoryFields).toContain("applicantFirstName");
    expect(form.mandatoryFields).not.toContain("applicationForDivorce");
    expect(form.optionalFields).toContain("applicationForDivorce");
  });

  it("should map 1:1 CCD fields in fis transform YAML when they are straight copies, and list the ones it cannot express", () => {
    const { yaml, unmapped } = fisTransformYaml(mini());
    const doc = parse(yaml) as Record<string, any>;
    const t = doc.uk.gov.hmcts.transform.caseTypeofApplication.X1;
    expect(t.caseFields).toEqual({ CASE_TYPE_ID: "NFD", EVENT_ID: "create-case" });
    expect(t.caseDataFields.applicant1FirstName).toBe("applicantFirstName");
    expect(unmapped.map((u) => u.ccd)).toContain("applicant1HomeAddress");
  });

  it("should write a draft-07 schema with case-insensitive patterns and no extra properties when keys list values", () => {
    const spec = formSpecSchema.parse({
      form: { formType: "X1" },
      sections: [
        {
          id: "1",
          title: "",
          fields: [
            fieldSchema.parse({
              keys: ["married", "applicantEmail"],
              emits: [
                { key: "married", value: "Yes" },
                { key: "married", value: "" }
              ]
            })
          ]
        }
      ]
    });
    expect(sscsSchema(spec)).toMatchObject({
      additionalProperties: false,
      properties: { married: { type: "string", pattern: "^(?:[Yy][Ee][Ss]|)$" }, applicantEmail: { type: "string", pattern: expect.stringContaining("@") } }
    });
  });

  it("should write the orchestrator's surname mapping from last-name keys when the spec does not list them", () => {
    const spec = formSpecSchema.parse({
      form: { formType: "X1" },
      sections: [{ id: "1", title: "", fields: [fieldSchema.parse({ keys: ["person1_last_name", "person1_first_name"] })] }]
    });
    expect(surnameMappingYaml(spec)).toBe("- formType: X1\n  ocrFields:\n    - person1_last_name\n");
    spec.form.surnameKeys = ["a", "b"];
    expect(surnameMappingYaml(spec)).toContain("    - a\n    - b");
  });

  it("should give a key an explicit JSON name when it has a lower-case letter then a capital, as nfdiv does", () => {
    expect(javaField("aSoleApplication")).toEqual({ field: "soleApplication", alias: "aSoleApplication" });
    expect(javaField("MarriageOutsideOfUK")).toEqual({ field: "marriageOutsideOfUK", alias: "MarriageOutsideOfUK" });
    expect(javaField("plainKey")).toEqual({ field: "plainKey" });
    expect(javaField("person1_last_name")).toEqual({ field: "person1LastName", alias: "person1_last_name" });
  });

  it("should write an nfdiv POJO whose keys the drift checker reads back as exactly the model's keys when it is generated", () => {
    const spec = mini();
    const files = new Map(nfdivFiles(spec, JAVA).map((f) => [f.path, f.content]));
    const pojo = javaPojoKeys(files.get("nfdiv/validation/data/OcrDataFields.java") ?? "").map((k) => k.key);
    expect(pojo).toEqual(keyModels(spec).map((k) => k.key));
  });

  it("should write a validator, a transformer with the sheet's rules as code, and tests for both when the nfdiv target is generated", () => {
    const files = new Map(nfdivFiles(mini(), JAVA).map((f) => [f.path, f.content]));
    const validator = files.get("nfdiv/validation/OcrValidator.java") ?? "";
    expect(validator).toContain('mandatory.put("applicantFirstName", data.getApplicantFirstName());');
    expect(validator).toContain("GROUP_EMPTY_WARNING");
    expect(validator).toContain('warnings.add("Row 1.1, branch 3: the transformation sheet gives case path warning");');
    const transformer = files.get("nfdiv/transformation/X1FormToCaseTransformer.java") ?? "";
    expect(transformer).toContain('if (matches(ocr.getApplicationForDivorce(), "true")) {');
    expect(transformer).toContain('caseData.put("divorceOrDissolution", "dissolution");');
    expect(transformer).toContain('caseData.put("applicant1FirstName", ocr.getApplicantFirstName());');
    expect(transformer).toContain("TODO(sheet 2.2)");
    expect(files.get("nfdiv/test/OcrValidatorGeneratedTest.java")).toContain("shouldWarnWhenApplicantFirstNameIsEmpty");
    expect(files.get("nfdiv/test/X1FormToCaseTransformerGeneratedTest.java")).toContain('containsEntry("applicant1FirstName", "Testname")');
  });

  it("should write a probate fields class with optional fields final, a validator naming the missing mandatory ones, and a test when the probate target is generated", () => {
    const files = new Map(probateFiles(mini(), JAVA).map((f) => [f.path, f.content]));
    expect(files.get("probate/ExceptionRecordOCRFields.java")).toContain("private String applicantFirstName;");
    expect(files.get("probate/ExceptionRecordOCRFields.java")).toContain("private final String applicantTownOrCity;");
    expect(files.get("probate/ExceptionRecordOCRFieldsValidator.java")).toContain('mandatory.put("applicantFirstName"');
  });

  it("should produce files for every target when the target is all", () => {
    for (const target of TARGETS) {
      expect(generateTarget(target, mini(), JAVA, "J").length).toBeGreaterThan(0);
    }
  });
});

describe("form types in output paths", () => {
  const withType = (formType: string) =>
    formSpecSchema.parse({ form: { formType, name: "n" }, sections: [{ id: "1", title: "", fields: [fieldSchema.parse({ keys: ["lastName"] })] }] });

  it.each(["D8/Revised", "../x", "A b", ""])("should refuse the form type %j when a file name is made from it", (formType) => {
    expect(() => generateTarget("fis", withType(formType), { basePackage: "x", classPrefix: "X" }, "J")).toThrow(/form type/);
  });

  it("should quote the form type in the orchestrator YAML when it holds YAML syntax", () => {
    const text = surnameMappingYaml(withType("a: b #c"));
    expect(parse(text)).toEqual([{ formType: "a: b #c", ocrFields: ["lastName"] }]);
  });
});
