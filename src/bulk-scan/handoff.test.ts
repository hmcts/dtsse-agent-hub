import { type FormSpec, formSpecSchema } from "@hmcts-cft/bulk-scan-spec";
import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_UPLOAD_BYTES } from "../assistant/uploads.ts";
import { defaultHandoffTarget, type HandoffNames, handoffPrompt, handoffRefusal, isHandoffTarget, isSignedOff } from "./handoff.ts";

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
  handoffPrompt({ spec, version: 3, target: "nfdiv", javaPackage: "com.example.bulkscan", names: NAMES, ...over });

describe("the target a hand-over starts on", () => {
  it.each([
    ["fis", "fis"],
    ["sscs", "sscs"],
    ["probate", "probate"],
    ["sptribs", "nfdiv"],
    ["nfdiv", "nfdiv"],
    [undefined, "nfdiv"]
  ])("should start %s on the %s pattern", (product, target) => {
    expect(defaultHandoffTarget({ ccdProduct: product })).toBe(target);
  });

  it("should offer only the four service patterns", () => {
    expect([isHandoffTarget("fis"), isHandoffTarget("envelopes"), isHandoffTarget(undefined)]).toEqual([true, false, false]);
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
  it("should name the form, its version and the service repo the case type was picked from", () => {
    const text = prompt(
      specOf({ ccdCaseTypeId: "CriminalInjuriesCompensation", ccdProduct: "sptribs", ccdRepo: "apps/sptribs/sptribs-case-api", ccdConfig: "config-generator" })
    );

    expect(text).toContain('Hand over the Bulk Scan form "T210 Application" (form type T210), signed off as version 3.');
    expect(text).toContain("The service repo is apps/sptribs/sptribs-case-api, which holds the CCD case type CriminalInjuriesCompensation.");
    expect(text).toContain("open a draft PR");
  });

  it("should ask the chat to find the repo when the case type was typed and its repo is not known", () => {
    expect(prompt(specOf({ ccdCaseTypeId: "NFD" }))).toContain(
      "The form maps into the CCD case type NFD. Find the service repo that defines it in the workspace."
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

    expect(text).toContain("Adds the 2 new CCD case fields listed in new-ccd-fields.json: applicantName (Text), hearingDate (Date).");
    expect(text).toContain("new-case-data-fields.java.txt in the zip");
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
    expect(text).toContain("Adds the generated envelopes (envelopes/ in the zip) as test fixtures.");
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
