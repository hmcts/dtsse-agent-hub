import { describe, expect, it } from "vitest";
import { makePdf, SAMPLE_FORM } from "./__fixtures__/make-pdf.ts";
import { fromPdf } from "./from-pdf.ts";
import { allFields, bundleSchema } from "./schema.ts";

const HOUSE = ["soleOrApplicant1FirstName", "applicationForDivorce", "applicationForDissolution", "soleOrApplicant1Solicitor"];
const CCD = ["applicant1FirstName", "divorceOrDissolution"];

describe("fromPdf on a form with fields", () => {
  it("should draft a spec that validates, with keys reused from the house style and CCD ids proposed", async () => {
    const { bundle } = await fromPdf({ pdf: await makePdf("sample", SAMPLE_FORM), houseKeys: HOUSE, ccdIds: CCD });
    expect(bundleSchema.parse(bundle)).toEqual(bundle);
    const fields = bundle.forms.flatMap(allFields);
    expect(fields.flatMap((f) => f.keys)).toEqual(expect.arrayContaining(["soleOrApplicant1FirstName", "applicationForDivorce", "soleOrApplicant1Solicitor"]));
    const application = fields.find((f) => f.id === "1.1");
    expect(application?.group).toEqual({
      kind: "xor",
      size: 2,
      options: [
        { key: "applicationForDivorce", label: "Divorce" },
        { key: "applicationForDissolution", label: "Dissolution" }
      ]
    });
    expect(fields.find((f) => f.label === "First name(s)")?.ccd).toEqual(["applicant1FirstName"]);
  });

  it("should flag the key, group and CCD id of every field and list them lowest confidence first", async () => {
    const { bundle, checklist } = await fromPdf({ pdf: await makePdf("sample", SAMPLE_FORM), houseKeys: HOUSE, ccdIds: CCD });
    const fields = bundle.forms.flatMap(allFields);
    for (const f of fields) {
      expect(f.review?.filter((r) => r.about === "key")).toHaveLength(f.keys.length);
      expect(f.review?.filter((r) => r.about === "ccd")).toHaveLength(1);
    }
    expect(fields.find((f) => f.id === "1.1")?.review).toContainEqual({ about: "group", reason: "2 checkboxes under one question", confidence: "medium" });
    expect(checklist[0]).toMatch(/^\[low\]/);
    expect(checklist.at(-1)).toMatch(/^\[(medium|high)\]/);
    expect(fields.find((f) => f.label === "Court name")?.review).toContainEqual({ about: "ccd", reason: "no CCD field close enough", confidence: "low" });
  });

  it("should not claim CCD guesses when no definition was given", async () => {
    const { bundle } = await fromPdf({ pdf: await makePdf("sample", SAMPLE_FORM) });
    expect(
      bundle.forms
        .flatMap(allFields)
        .flatMap((f) => f.review ?? [])
        .some((r) => r.about === "ccd")
    ).toBe(false);
  });

  it("should list each page's keys in page order", async () => {
    const { bundle } = await fromPdf({ pdf: await makePdf("sample", SAMPLE_FORM) });
    const order = bundle.forms[0]?.pageOrder ?? [];
    expect(order.map((p) => p.page)).toEqual([1, 2]);
    expect(order[1]?.keys).toEqual(expect.arrayContaining(["courtName", "card", "cheque"]));
  });
});

describe("fromPdf on a flat form", () => {
  it("should return an empty draft and a prompt carrying the page text", async () => {
    const pdf = await makePdf("flat", [{ texts: [{ text: "Section 1 - Your details", x: 40, y: 700 }] }, {}]);
    const result = await fromPdf({ pdf });
    expect(result.bundle.forms[0]?.sections).toEqual([]);
    expect(result.needsReview?.reason).toBe("the PDF has no AcroForm fields");
    expect(result.needsReview?.promptText).toContain("Section 1 - Your details");
    expect(result.needsReview?.promptText).toContain("(no text layer: read the page image)");
  });
});
