import { type FormSpec, formSpecSchema } from "@hmcts-cft/bulk-scan-spec";
import { newCcdFields } from "@hmcts-cft/bulk-scan-spec/ccd-match";
import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_UPLOAD_BYTES } from "../assistant/uploads.ts";
import { defaultHandoffTarget, formTypeProblem, type HandoffNames, handoffPrompt, handoffRefusal, isHandoffTarget, isSignedOff } from "./handoff.ts";

const NAMES: HandoffNames = {
  code: "T210-nfdiv.zip",
  spec: "T210-spec.json",
  sheet: "T210-transformation.xlsx",
  newFields: "new-ccd-fields.json",
  orchestrator: "orchestrator/form-type-to-surname-ocr-field-mappings.T210.yaml"
};

function specOf(form: object, newFields: { id: string; type: string }[] = []): FormSpec {
  return formSpecSchema.parse({
    form: { name: "T210 Application", formType: "T210", ...form },
    sections: [
      {
        id: "1",
        title: "About",
        fields: newFields.map((f, i) => ({ id: `1.${i}`, label: `Field ${f.id}`, keys: [`k${i}`], ccd: [f.id], ccdMatch: { status: "new", newField: f } }))
      }
    ]
  });
}

const prompt = (spec: FormSpec, over: Partial<Parameters<typeof handoffPrompt>[0]> = {}) =>
  handoffPrompt({ spec, version: 3, target: "nfdiv", javaPackage: "com.example.bulkscan", names: NAMES, newFields: newCcdFields(spec), ...over });

describe("the target a hand-over starts on", () => {
  it.each([
    ["PRLAPPS", "prl", "fis"],
    ["PRLAPPS", "fis", "fis"],
    ["A58", "adoption", "fis"],
    ["A59", "fis", "fis"],
    ["A60", "fis", "fis"],
    ["C51", "fis", "fis"],
    ["ADOPTION", "adoption", "nfdiv"],
    ["CIVIL", "civil", "nfdiv"],
    ["CriminalInjuriesCompensation", "sptribs", "nfdiv"],
    ["SSCS", "sscs", "sscs"],
    ["Probate", "probate", "probate"],
    [undefined, "fis", "nfdiv"],
    [undefined, undefined, "nfdiv"]
  ])("should start case type %s of product %s on the %s pattern", (ccdCaseTypeId, ccdProduct, target) => {
    expect(defaultHandoffTarget({ ccdCaseTypeId, ccdProduct })).toBe(target);
  });

  it("should offer only the four service patterns", () => {
    expect([isHandoffTarget("fis"), isHandoffTarget("envelopes"), isHandoffTarget(undefined)]).toEqual([true, false, false]);
  });
});

describe("whether a form type can be handed over", () => {
  it.each([
    ["T210", null],
    ["c100-1_a", null],
    ["", "Set the form type (document_sub_type) in Form details first."],
    ["FORM A1", expect.stringContaining('the form type "FORM A1" cannot be used in a file name')],
    ["C100/1", expect.stringContaining("cannot be used in a file name")]
  ])("should say %s is %s", (formType, problem) => {
    expect(formTypeProblem(formType)).toEqual(problem);
  });
});

describe("whether a version is signed off", () => {
  const versions = [
    { version: 2, signedOffAt: null },
    { version: 1, signedOffAt: "2026-11-01T10:00:00.000Z" }
  ];

  it("should count only a version that carries a sign-off", () => {
    expect([isSignedOff(versions, 1), isSignedOff(versions, 2), isSignedOff(versions, 3)]).toEqual([true, false, false]);
  });
});

describe("the hand-over prompt", () => {
  it("should name the form and version, and say the picked repo is the service for a config-generator product", () => {
    const text = prompt(
      specOf({ ccdCaseTypeId: "CriminalInjuriesCompensation", ccdProduct: "sptribs", ccdRepo: "apps/sptribs/sptribs-case-api", ccdConfig: "config-generator" })
    );

    expect(text).toContain('Hand over the Bulk Scan form "T210 Application" (form type T210), signed off as version 3.');
    expect(text).toContain(
      "The CCD case type CriminalInjuriesCompensation (product sptribs) is defined in apps/sptribs/sptribs-case-api, a config-generator service, so that repo is the service repo."
    );
    expect(text).toContain("In the service repo, open a draft PR");
    expect(text).not.toContain("Find the service repo");
  });

  it.each([
    ["PRLAPPS", "prl", "apps/prl/prl-ccd-definitions"],
    ["A58", "adoption", "apps/adoption/adoption-cos-api"]
  ])("should name fis-bulk-scan-api as the service for case type %s whatever product and repo define it", (ccdCaseTypeId, ccdProduct, ccdRepo) => {
    const text = prompt(specOf({ ccdCaseTypeId, ccdProduct, ccdRepo, ccdConfig: ccdProduct === "adoption" ? "config-generator" : "json" }));

    expect(text).toContain(
      `The CCD case type ${ccdCaseTypeId} (product ${ccdProduct}) is transformed by apps/fis/fis-bulk-scan-api, which holds the config-driven transformations, so that is the service repo. The CCD definition is in ${ccdRepo}.`
    );
    expect(text).not.toContain("Find the service repo");
  });

  it("should ask for the JURISDICTION placeholder in the envelopes to be replaced before they are fixtures", () => {
    expect(prompt(specOf({}))).toContain("after replacing the JURISDICTION placeholder in them with the service's bulk-scan jurisdiction");
  });

  it("should say the repo holds only the definition and ask the chat to find the service for a JSON product", () => {
    const text = prompt(specOf({ ccdCaseTypeId: "CIVIL", ccdProduct: "civil", ccdRepo: "apps/civil/civil-ccd-definition", ccdConfig: "json" }));

    expect(text).toContain(
      "The CCD definition for the CCD case type CIVIL (product civil) is in apps/civil/civil-ccd-definition, which holds the definition and may not be the service."
    );
    expect(text).toContain(
      "Find the service repo that handles this product's bulk-scan callbacks, from the product's repos in apps/civil/AGENTS.md and the service-config in apps/bulk-scan/bulk-scan-orchestrator"
    );
  });

  it("should ask the chat to find the repo when the case type was typed and its repo is not known", () => {
    expect(prompt(specOf({ ccdCaseTypeId: "NFD" }))).toContain(
      "The form maps into the CCD case type NFD. Find the repo that defines it in the workspace. Find the service repo"
    );
  });

  it("should ask the chat to find the service when no case type was picked", () => {
    expect(prompt(specOf({}))).toContain("No case type was picked for this form, so find the service it belongs to");
  });

  it("should list the new case fields, and say where the CaseData snippet is for a config-generator service", () => {
    const text = prompt(
      specOf({ ccdConfig: "config-generator" }, [
        { id: "applicantName", type: "Text" },
        { id: "hearingDate", type: "Date" }
      ])
    );

    expect(text).toContain("Adds the 2 new CCD case fields under `fields` in new-ccd-fields.json: applicantName (Text), hearingDate (Date).");
    expect(text).toContain("new-case-data-fields.java.txt in the zip");
  });

  it("should name complex members apart from fields, as new-ccd-fields.json does, and give the snippet only for fields", () => {
    const text = prompt(
      specOf({ ccdConfig: "config-generator" }, [
        { id: "applicantName", type: "Text" },
        { id: "address.County", type: "Text" }
      ])
    );

    expect(text).toContain("Adds the 1 new CCD case field under `fields` in new-ccd-fields.json: applicantName (Text).");
    expect(text).toContain(
      "Adds the 1 new member of existing complex types under `complexMembers` in new-ccd-fields.json, to the type of the parent field: address.County (Text)."
    );
    expect(text).not.toContain("2 new CCD case fields");
  });

  it("should clip a very long form name and type where they go into the prompt", () => {
    const text = prompt(specOf({ name: "N".repeat(500), formType: "T".repeat(500) }));

    expect(text).toContain(`"${"N".repeat(100)}" (form type ${"T".repeat(100)})`);
    expect(text).not.toContain("N".repeat(101));
  });

  it("should say a form with no new fields adds none", () => {
    const text = prompt(specOf({}), { names: { ...NAMES, newFields: undefined } });

    expect(text).toContain("Adds no case fields: every field the form maps to already exists.");
    expect(text).not.toContain("new-ccd-fields.json");
  });

  it("should cut a long list of new fields to the first few and count the rest", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ id: `field${i}`, type: "Text" }));

    expect(prompt(specOf({}, many))).toContain("field7 (Text) and 3 more.");
  });

  it("should name the package probate code is written in, without the .bulkscan the others carry", () => {
    expect(prompt(specOf({}), { target: "probate", javaPackage: "uk.gov.hmcts.probate.bulkscan" })).toContain(
      "written in the Java package uk.gov.hmcts.probate,"
    );
    expect(prompt(specOf({}), { target: "nfdiv", javaPackage: "uk.gov.hmcts.sptribs.bulkscan" })).toContain(
      "written in the Java package uk.gov.hmcts.sptribs.bulkscan,"
    );
  });

  it("should give the Java package for a Java target and none for the others", () => {
    expect(prompt(specOf({}), { javaPackage: "uk.gov.hmcts.sptribs.bulkscan" })).toContain("written in the Java package uk.gov.hmcts.sptribs.bulkscan");
    expect(prompt(specOf({}), { target: "fis" })).not.toContain("Java package");
  });

  it("should ask for the validators, the exception record, the fixtures, the orchestrator PR and the TODO(sheet) rows", () => {
    const text = prompt(specOf({}));

    expect(text).toContain(
      "Registers form type T210 with the service's validate-ocr and transformation endpoints, following the repo's existing bulk-scan code. If the repo has none, say so"
    );
    expect(text).toContain("Crafts the exception-record case type definition for the service. That is not generated");
    expect(text).toContain("Adds the generated envelopes (envelopes/ in the zip) as test fixtures, after");
    expect(text).toContain("apps/bulk-scan/bulk-scan-orchestrator");
    expect(text).toContain("Resolve each from T210-spec.json and T210-transformation.xlsx, or leave a clear note about it in the PR.");
  });
});

describe("what a hand-over may attach", () => {
  const file = (bytes: number, fileName = "a.zip") => ({ fileName, bytes: { byteLength: bytes } });

  it("should accept the four files the Assistant allows on a message", () => {
    expect(handoffRefusal(Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, () => file(10)))).toBeNull();
  });

  it("should refuse more files than a message carries", () => {
    expect(handoffRefusal(Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, () => file(10)))).toBe(
      "a message carries at most 4 files, and this hand-over has 5"
    );
  });

  it("should refuse an empty file and name it", () => {
    expect(handoffRefusal([file(0, "new-ccd-fields.json")])).toBe("new-ccd-fields.json is empty");
  });

  it("should refuse a file over the size one file may be", () => {
    expect(handoffRefusal([file(MAX_UPLOAD_BYTES + 1, "big.zip")])).toContain("big.zip is 25.0 MB, over the 25 MB a file may be");
  });
});
