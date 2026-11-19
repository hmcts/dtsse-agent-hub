import type { FormSpec } from "@hmcts-cft/bulk-scan-spec";
import { describe, expect, it } from "vitest";
import { issuesByField, maxLengthOf, patchField, patchHeader, reviewChecklist, wordsOf } from "./edit.ts";

const field = (over: object = {}) => ({ role: "field", label: "", inputType: "text", mandatory: "optional", keys: [], ccd: [], rules: [], todo: [], ...over });
const spec = {
  form: { name: "D8", formType: "D8", poBox: "PO 1" },
  sections: [
    { id: "1", title: "A", fields: [field({ id: "1.1", keys: ["a"], regex: "x", maxLength: 5 }), field({ id: "1.2", keys: ["b"] })] },
    { id: "2", title: "B", fields: [field({ id: "2.1", keys: ["c"], review: [{ about: "key", reason: "guess", confidence: "low" }] })] }
  ],
  composes: [],
  pageOrder: [],
  expectedDocuments: []
} as unknown as FormSpec;

describe("patching a spec", () => {
  it("should change one field and leave the others as they were", () => {
    const next = patchField(spec, 0, 1, { label: "Second" });
    expect(next.sections[0]?.fields[1]?.label).toBe("Second");
    expect(next.sections[0]?.fields[0]).toBe(spec.sections[0]?.fields[0]);
    expect(next.sections[1]).toBe(spec.sections[1]);
    expect(spec.sections[0]?.fields[1]?.label).toBe("");
  });

  it("should drop an id, regex or maximum length that is emptied", () => {
    const next = patchField(spec, 0, 0, { id: "", regex: "", maxLength: undefined });
    expect(next.sections[0]?.fields[0]).not.toHaveProperty("id");
    expect(next.sections[0]?.fields[0]).not.toHaveProperty("regex");
    expect(next.sections[0]?.fields[0]).not.toHaveProperty("maxLength");
  });

  it("should set the form's name and drop a PO box that is emptied", () => {
    const next = patchHeader(spec, { name: "D9", poBox: "" });
    expect(next.form.name).toBe("D9");
    expect(next.form).not.toHaveProperty("poBox");
    expect(patchHeader(spec, { formType: "" }).form.formType).toBe("");
  });
});

describe("reading what was typed", () => {
  it("should split keys on spaces, commas and new lines", () => {
    expect(wordsOf(" a, b\nc  d ")).toEqual(["a", "b", "c", "d"]);
  });

  it("should read a maximum length as a number, and an empty box as none", () => {
    expect(maxLengthOf("12")).toBe(12);
    expect(maxLengthOf("  ")).toBeUndefined();
    expect(maxLengthOf("x")).toBeNaN();
  });
});

describe("issues", () => {
  it("should attach an issue to its field row and keep the rest for the form", () => {
    const { fields, form } = issuesByField([
      { path: "sections.0.fields.1.keys.0", message: "Too small" },
      { path: "sections.0.fields.1", message: "bad group" },
      { path: "sections", message: "the key is not a word" },
      { path: "", message: "Invalid input" }
    ]);
    expect(fields.get("0.1")).toEqual(["keys.0: Too small", "bad group"]);
    expect(form).toEqual(["sections: the key is not a word", "Invalid input"]);
  });
});

describe("review checklist", () => {
  it("should list every marked guess, lowest confidence first, naming its field", () => {
    expect(reviewChecklist(spec)).toEqual([{ at: "1.0", where: "2.1", about: "key", reason: "guess", confidence: "low" }]);
    const first = spec.sections[0]?.fields[0];
    const mixed = {
      ...spec,
      sections: [{ ...(spec.sections[0] as object), fields: [{ ...first, review: [{ about: "ccd", reason: "r", confidence: "high" }] }] }, spec.sections[1]]
    } as unknown as FormSpec;
    expect(reviewChecklist(mixed).map((l) => l.confidence)).toEqual(["low", "high"]);
  });
});
