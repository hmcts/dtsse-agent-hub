import { describe, expect, it } from "vitest";
import { makePdf, SAMPLE_FORM } from "./__fixtures__/make-pdf.ts";
import { ROUTED_FORM } from "./__fixtures__/t210-routes.ts";
import { isQuestion, keyModels } from "./codegen/model.ts";
import { fromPdf } from "./from-pdf.ts";
import type { Field, FormSpec } from "./schema.ts";
import { allFields } from "./schema.ts";

async function fieldsOf(pages: Parameters<typeof makePdf>[1]): Promise<Field[]> {
  const { bundle } = await fromPdf({ pdf: await makePdf("routed", pages) });
  return bundle.forms.flatMap(allFields);
}

const byId = (fields: Field[], id: string): Field => fields.find((f) => f.id === id) as Field;
const markers = (f: Field) => (f.review ?? []).filter((r) => r.about === "mandatory");

describe("mandatory, optional and conditional fields of a PDF draft", () => {
  it("should make a field mandatory when the form does not mark it or skip it", async () => {
    const fields = await fieldsOf(ROUTED_FORM);
    expect(byId(fields, "1.1")).toMatchObject({ mandatory: "mandatory" });
    expect(byId(fields, "2.5")).toMatchObject({ mandatory: "mandatory" });
    expect(markers(byId(fields, "6.1"))).toEqual([]);
  });

  it("should make a field optional when its own words say optional or if known", async () => {
    const fields = await fieldsOf(ROUTED_FORM);
    expect(byId(fields, "3.2")).toMatchObject({ mandatory: "optional" });
    expect(byId(fields, "5.4")).toMatchObject({ mandatory: "optional" });
    expect(fields.find((f) => f.label === "Crime reference number (if known)")).toMatchObject({ mandatory: "optional" });
    expect(markers(byId(fields, "3.2"))).toEqual([{ about: "mandatory", reason: "optional: the form marks it (optional)", confidence: "high" }]);
  });

  it("should require a section only when the option that goes to it is ticked", async () => {
    const fields = await fieldsOf(ROUTED_FORM);
    const [minor] = byId(fields, "2.5").keys;
    const minorField = byId(fields, "3.1");
    expect(minorField).toMatchObject({
      mandatory: "conditional",
      required: { label: "'Yes I am appealing on behalf of a minor' is ticked", when: { [minor as string]: { ticked: true } } }
    });
    expect(markers(minorField)[0]?.reason).toContain("question 2.5 sends 'Yes I am appealing on behalf of a minor' (go to Section 3) here");
  });

  it("should require the section that follows one the form does not route out of when any option but the skipping one is ticked", async () => {
    const fields = await fieldsOf(ROUTED_FORM);
    const [, , none] = byId(fields, "2.5").keys;
    const deceased = byId(fields, "4.1");
    expect(deceased).toMatchObject({ mandatory: "conditional", required: { label: "'No' is not ticked", when: { [none as string]: { ticked: false } } } });
    expect(markers(deceased)[0]).toMatchObject({ confidence: "low" });
    expect(markers(deceased)[0]?.reason).toContain(
      "reached by 'Yes I am appealing on behalf of a minor' (go to Section 3) and 'Yes I am appealing following a bereavement' (go to Section 4)"
    );
  });

  it("should follow a go to question route and read a Yes and No pair's one key as the answer", async () => {
    const fields = await fieldsOf(ROUTED_FORM);
    const [answer] = byId(fields, "5.1").keys;
    expect(byId(fields, "5.1")).toMatchObject({ mandatory: "mandatory" });
    expect(byId(fields, "5.2")).toMatchObject({
      mandatory: "conditional",
      required: { label: "'Do you have a representative?' is answered Yes", when: { [answer as string]: { ticked: true } } }
    });
  });

  it("should make a field after the skipped sections mandatory again", async () => {
    expect(byId(await fieldsOf(ROUTED_FORM), "6.1")).toMatchObject({ mandatory: "mandatory" });
  });

  it("should keep a field optional when it is also in a skipped section", async () => {
    const county = byId(await fieldsOf(ROUTED_FORM), "3.2");
    expect(county.mandatory).toBe("optional");
    expect(county.required).toBeUndefined();
  });

  it("should leave a field mandatory, saying why, when a route leads to a section the form does not have", async () => {
    const pages = structuredClone(ROUTED_FORM);
    const label = pages[0]?.texts?.find((t) => t.text.startsWith("No > go to"));
    if (label) {
      label.text = "No > go to Section 12";
    }
    const fields = await fieldsOf(pages);
    expect(byId(fields, "3.1")).toMatchObject({ mandatory: "mandatory" });
    expect(markers(byId(fields, "6.1"))[0]).toMatchObject({ confidence: "low" });
    expect(markers(byId(fields, "6.1"))[0]?.reason).toContain("leads to section 12, which is not after it in the form");
  });

  it("should make every field of a form with no routes and no notes mandatory", async () => {
    const fields = await fieldsOf(SAMPLE_FORM);
    expect(fields.every((f) => f.mandatory === "mandatory")).toBe(true);
  });
});

describe("a format stated in a margin note", () => {
  it("should propose a regex from a note saying the answer begins with a letter, citing the sentence", async () => {
    const reference = byId(await fieldsOf(ROUTED_FORM), "1.1");
    expect(reference.regex).toBe("^[XG].*");
    expect(reference.review).toContainEqual({
      about: "regex",
      reason: '^[XG].*: the form says "CICA reference numbers begin with the letter X or G."',
      confidence: "medium"
    });
  });

  it("should propose no regex for a question with no note", async () => {
    expect(byId(await fieldsOf(ROUTED_FORM), "6.1").regex).toBeUndefined();
  });
});

describe("routes in the SSCS1 style", () => {
  const SSCS_STYLE: Parameters<typeof makePdf>[1] = [
    {
      texts: [
        { text: "Section 6: Your appeal hearing", x: 28, y: 750 },
        { text: "I want to take part in the hearing. Go to Section 6a", x: 77, y: 718 },
        { text: "I do not want to take part in the hearing. Go to Section 9", x: 77, y: 688 },
        { text: "Section 6a: Your telephone hearing", x: 28, y: 640 },
        { text: "Phone number for the hearing", x: 57, y: 600 },
        { text: "Section 9: About you", x: 28, y: 520 },
        { text: "1. What is your main language?", x: 28, y: 495 },
        { text: "English, go to question 3", x: 77, y: 468 },
        { text: "Other, give details", x: 77, y: 438 },
        { text: "2. Other language", x: 28, y: 400 },
        { text: "3. What is your religion?", x: 28, y: 330 }
      ],
      checkboxes: [
        { name: "take", x: 57, y: 715 },
        { name: "notTake", x: 57, y: 685 },
        { name: "english", x: 57, y: 465 },
        { name: "other", x: 57, y: 435 }
      ],
      textBoxes: [
        { name: "phone", x: 57, y: 570 },
        { name: "otherLanguage", x: 57, y: 370 },
        { name: "religion", x: 57, y: 300 }
      ]
    }
  ];

  it("should follow a go to route to a section with a letter, and one to an undotted question number", async () => {
    const fields = await fieldsOf(SSCS_STYLE);
    const phone = fields.find((f) => f.label === "Phone number for the hearing") as Field;
    expect(phone).toMatchObject({ mandatory: "conditional", required: { label: "'I want to take part in the hearing' is ticked" } });
    expect(byId(fields, "2")).toMatchObject({ mandatory: "conditional", required: { label: "'Other, give details' is ticked" } });
    expect(byId(fields, "3")).toMatchObject({ mandatory: "mandatory" });
    expect(fields.flatMap(markers).filter((m) => m.reason.includes("must check"))).toEqual([]);
  });
});

describe("tick boxes", () => {
  it("should give a Yes and No pair the Yes and No values the D8 sheet lists, so No is an answer to a mandatory question", async () => {
    const { bundle } = await fromPdf({ pdf: await makePdf("sample", SAMPLE_FORM) });
    const form = bundle.forms[0] as FormSpec;
    const pair = form.sections.flatMap((s) => s.fields).find((f) => f.label === "Do you have a solicitor?") as Field;
    expect(pair).toMatchObject({ mandatory: "mandatory", keys: [expect.any(String)] });
    const [key] = pair.keys as [string];
    expect(pair.emits).toEqual([
      { when: "if yes", key, value: "Yes" },
      { when: "if no", key, value: "No" },
      { when: "if empty", key, value: "" }
    ]);
    expect(isQuestion(keyModels({ ...form, form: { ...form.form, formType: "X" } }).find((m) => m.key === key) as never)).toBe(true);
  });

  const single = (text: string): Parameters<typeof makePdf>[1] => [
    {
      texts: [
        { text: "1.1 " + text, x: 28, y: 700 },
        { text: "I agree", x: 77, y: 673 }
      ],
      checkboxes: [{ name: "agree", x: 57, y: 670 }]
    }
  ];

  it("should make a single tick box optional when the form does not say it must be ticked", async () => {
    const [box] = await fieldsOf(single("Declaration"));
    expect(box).toMatchObject({ inputType: "checkbox", mandatory: "optional" });
    expect(markers(box as Field)).toEqual([
      { about: "mandatory", reason: "optional: a single tick box, which the form does not say must be ticked", confidence: "medium" }
    ]);
  });

  it("should make a single tick box mandatory when the form says it must be ticked", async () => {
    const [box] = await fieldsOf(single("You must tick this box to confirm"));
    expect(box).toMatchObject({ mandatory: "mandatory" });
  });
});
