import { describe, expect, it } from "vitest";
import { makePdf, SAMPLE_FORM } from "./__fixtures__/make-pdf.ts";
import type { DraftField } from "./pdf-draft.ts";
import { draftFields } from "./pdf-draft.ts";
import { extractPdf } from "./pdf-extract.ts";

async function draftOf(...pages: Parameters<typeof makePdf>[1]): Promise<DraftField[]> {
  return draftFields(await extractPdf(await makePdf("draft", pages)));
}

describe("draftFields", () => {
  it("should put checkboxes under one numbered question into one XoR group labelled by the question", async () => {
    const [first] = await draftOf(...SAMPLE_FORM);
    expect(first).toMatchObject({ sectionId: "1", sectionTitle: "Section 1 - Your application", groupSize: 2, slotLabels: ["Divorce", "Dissolution"] });
    expect(first?.field).toMatchObject({ id: "1.1", label: "What application are you making?", inputType: "checkbox" });
    expect(first?.reasons).toEqual([{ about: "group", reason: "2 checkboxes under one question", confidence: "medium" }]);
  });

  it("should give a Yes and No pair one key and keep its group size", async () => {
    const yesNo = (await draftOf(...SAMPLE_FORM))[1];
    expect(yesNo).toMatchObject({ groupSize: 2, slotLabels: ["Do you have a solicitor?"] });
    expect(yesNo?.field.keys).toEqual([""]);
  });

  it("should merge boxes stacked under one label into one text field and add up their lengths", async () => {
    const name = (await draftOf(...SAMPLE_FORM)).find((d) => d.field.label === "First name(s)");
    expect(name?.field).toMatchObject({ inputType: "text", maxLength: 30, keys: [""] });
  });

  it("should read day, month and year boxes as one date labelled by the line above them", async () => {
    const date = (await draftOf(...SAMPLE_FORM)).find((d) => d.field.inputType === "date");
    expect(date?.field.label).toBe("Date of marriage");
    expect(date?.field.keys).toHaveLength(3);
    expect(date?.reasons[0]?.about).toBe("type");
  });

  it("should keep the section and question across pages and group a radio group's buttons however they are placed", async () => {
    const fields = await draftOf(...SAMPLE_FORM);
    const pay = fields.find((d) => d.field.id === "2.3");
    expect(pay).toMatchObject({ page: 2, sectionId: "2", groupSize: 2, slotLabels: ["By card", "By cheque"] });
    expect(pay?.reasons[0]?.confidence).toBe("high");
    expect(fields.find((d) => d.field.id === "2.2")?.field.label).toBe("Court name");
  });

  it("should take an undotted number as a question only when a box is just below it, not as numbered guidance", async () => {
    const fields = await draftOf({
      texts: [
        { text: "1. Use black ink", x: 28, y: 740 },
        { text: "Notes end here", x: 28, y: 600 },
        { text: "2. What is your main language?", x: 28, y: 400 }
      ],
      textBoxes: [
        { name: "first", x: 57, y: 500 },
        { name: "second", x: 57, y: 360 }
      ]
    });
    expect(fields.map((d) => d.field.id)).toEqual([undefined, "2"]);
  });

  it("should keep a route's words without the comma that led into them", async () => {
    const [group] = await draftOf({
      texts: [
        { text: "1.1 What is your main language?", x: 28, y: 710 },
        { text: "English, go to question 3", x: 77, y: 683 },
        { text: "Welsh, go to question 3", x: 77, y: 653 }
      ],
      checkboxes: [
        { name: "a", x: 57, y: 680 },
        { name: "b", x: 57, y: 650 }
      ]
    });
    expect(group?.choices?.map((c) => [c.label, c.route?.text])).toEqual([
      ["English", "go to question 3"],
      ["Welsh", "go to question 3"]
    ]);
  });

  it("should end a checkbox group at a text box", async () => {
    const fields = await draftOf({
      texts: [
        { text: "3.1 Statement", x: 28, y: 700 },
        { text: "I agree", x: 77, y: 653 },
        { text: "I also agree", x: 77, y: 563 }
      ],
      checkboxes: [
        { name: "a", x: 57, y: 650 },
        { name: "b", x: 57, y: 560 }
      ],
      textBoxes: [{ name: "between", x: 57, y: 600 }]
    });
    expect(fields.map((d) => d.field.inputType)).toEqual(["checkbox", "text", "checkbox"]);
  });

  it("should group unnumbered checkboxes only when they are close together", async () => {
    const fields = await draftOf({
      texts: [
        { text: "Benefit", x: 28, y: 720 },
        { text: "PIP", x: 77, y: 683 },
        { text: "ESA", x: 77, y: 663 },
        { text: "Other", x: 77, y: 400 }
      ],
      checkboxes: [
        { name: "a", x: 57, y: 680 },
        { name: "b", x: 57, y: 660 },
        { name: "c", x: 57, y: 397 }
      ]
    });
    expect(fields.map((d) => d.slotLabels)).toEqual([["PIP", "ESA"], ["Other"]]);
  });

  it("should fall back to the field's tooltip or name when the page has no text near it", async () => {
    const [only] = await draftOf({ textBoxes: [{ name: "Text9", x: 57, y: 400 }] });
    expect(only?.field.label).toBe("Text9");
  });

  it("should put fields above the first heading in a section of their own", async () => {
    const fields = await draftOf({
      texts: [
        { text: "Surname", x: 57, y: 720 },
        { text: "Section 1 - About you", x: 28, y: 640 },
        { text: "Town", x: 57, y: 610 }
      ],
      textBoxes: [
        { name: "s", x: 57, y: 690 },
        { name: "t", x: 57, y: 580 }
      ]
    });
    expect(fields.map((d) => [d.sectionId, d.sectionTitle])).toEqual([
      ["0", ""],
      ["1", "Section 1 - About you"]
    ]);
  });

  it("should give a box taller than the question text on the same row to that question", async () => {
    const fields = await draftOf({
      texts: [
        { text: "2.1 Earlier question", x: 28, y: 740 },
        { text: "3.1 Court", x: 28, y: 700 }
      ],
      textBoxes: [{ name: "court", x: 300, y: 695, width: 150 }]
    });
    expect(fields.map((d) => d.field.id)).toEqual(["3.1"]);
  });

  it("should label a checkbox with nothing near it by its field name", async () => {
    const [only] = await draftOf({ checkboxes: [{ name: "agree", x: 57, y: 400 }] });
    expect(only?.field.label).toBe("agree");
  });
});
