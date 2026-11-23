import { type FormSpec, formSpecSchema } from "@hmcts-cft/bulk-scan-spec";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../agent-api/http.ts";
import { handoffFiles } from "./handoff-files.ts";

const refusal = vi.hoisted(() => ({ message: null as string | null }));
vi.mock("./handoff.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./handoff.ts")>();
  return { ...actual, handoffRefusal: (files: Parameters<typeof actual.handoffRefusal>[0]) => refusal.message ?? actual.handoffRefusal(files) };
});

function specOf(newFields: { id: string; type: string }[]): FormSpec {
  return formSpecSchema.parse({
    form: { name: "T210", formType: "T210", ccdCaseTypeId: "CIC", ccdConfig: "config-generator" },
    sections: [
      {
        id: "1",
        title: "About",
        fields: [
          { id: "1.1", label: "First name", keys: ["firstName"], mandatory: "mandatory", ccd: ["applicantFirstName"] },
          ...newFields.map((f, i) => ({ id: `1.${i + 2}`, label: f.id, keys: [`k${i}`], ccd: [f.id], ccdMatch: { status: "new", newField: f } }))
        ]
      }
    ]
  });
}

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

describe("the files of a hand-over", () => {
  it("should attach the code zip, the spec and the transformation sheet when the form has no new fields", async () => {
    const { files, names } = await handoffFiles(specOf([]), "nfdiv", "com.example.bulkscan");

    expect(files.map((f) => f.fileName)).toEqual(["T210-nfdiv.zip", "T210-spec.json", "T210-transformation.xlsx"]);
    expect(names.newFields).toBeUndefined();
  });

  it("should add the new case fields file as a fourth file when the form has new fields", async () => {
    const { files, names } = await handoffFiles(specOf([{ id: "applicantNickname", type: "Text" }]), "nfdiv", "com.example.bulkscan");

    expect(files.map((f) => f.fileName)).toEqual(["T210-nfdiv.zip", "T210-spec.json", "T210-transformation.xlsx", "new-ccd-fields.json"]);
    expect(names.newFields).toBe("new-ccd-fields.json");
    expect(JSON.parse(text(files[3]?.bytes ?? new Uint8Array())).fields).toEqual([{ id: "applicantNickname", type: "Text", label: "applicantNickname" }]);
  });

  it("should carry the envelopes, the orchestrator mapping and the CaseData snippet inside the zip", async () => {
    const { files, names } = await handoffFiles(specOf([{ id: "applicantNickname", type: "Text" }]), "nfdiv", "com.example.bulkscan");
    const zip = text(files[0]?.bytes ?? new Uint8Array());

    expect(zip).toContain("envelopes/validate-ocr/");
    expect(zip).toContain(names.orchestrator);
    expect(zip).toContain("new-case-data-fields.java.txt");
  });

  it("should attach the spec as the saved JSON", async () => {
    const spec = specOf([]);
    const { files } = await handoffFiles(spec, "fis", "com.example.bulkscan");

    expect(JSON.parse(text(files[1]?.bytes ?? new Uint8Array()))).toEqual(JSON.parse(JSON.stringify(spec)));
  });

  it("should refuse with a 413 that says why when the files would pass a cap", async () => {
    refusal.message = "this hand-over has 5 files";
    try {
      await expect(handoffFiles(specOf([]), "nfdiv", "com.example.bulkscan")).rejects.toMatchObject({
        status: 413,
        message: "This cannot be handed over: this hand-over has 5 files."
      });
      await expect(handoffFiles(specOf([]), "nfdiv", "com.example.bulkscan")).rejects.toBeInstanceOf(HttpError);
    } finally {
      refusal.message = null;
    }
  });
});
