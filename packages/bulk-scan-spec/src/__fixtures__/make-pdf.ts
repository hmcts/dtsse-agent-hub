import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

export interface PageLayout {
  /** Text drawn at a baseline position, in PDF points from the bottom-left. */
  texts?: { text: string; x: number; y: number }[];
  textBoxes?: { name: string; x: number; y: number; width?: number; maxLength?: number }[];
  checkboxes?: { name: string; x: number; y: number }[];
  radios?: { name: string; options: { value: string; x: number; y: number }[] }[];
}

/** Writes a small PDF to a temp directory and returns its path. A page with no boxes gives a flat, form-less page. */
export async function makePdf(name: string, pages: PageLayout[]): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();
  for (const layout of pages) {
    const page = doc.addPage([612, 792]);
    for (const t of layout.texts ?? []) {
      page.drawText(t.text, { x: t.x, y: t.y, size: 11, font });
    }
    for (const b of layout.textBoxes ?? []) {
      const field = form.createTextField(b.name);
      if (b.maxLength) {
        field.setMaxLength(b.maxLength);
      }
      field.addToPage(page, { x: b.x, y: b.y, width: b.width ?? 200, height: 20 });
    }
    for (const c of layout.checkboxes ?? []) {
      form.createCheckBox(c.name).addToPage(page, { x: c.x, y: c.y, width: 14, height: 14 });
    }
    for (const r of layout.radios ?? []) {
      const group = form.createRadioGroup(r.name);
      for (const o of r.options) {
        group.addOptionToPage(o.value, page, { x: o.x, y: o.y, width: 14, height: 14 });
      }
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "pdf-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.pdf`);
  writeFileSync(path, await doc.save());
  return path;
}

/** A two-page form in the layout of the GOV.UK forms: numbered questions under section headings, checkbox options with their labels to the right. */
export const SAMPLE_FORM: PageLayout[] = [
  {
    texts: [
      { text: "Section 1 - Your application", x: 28, y: 740 },
      { text: "1.1 What application are you making?", x: 28, y: 710 },
      { text: "Divorce", x: 77, y: 683 },
      { text: "Dissolution", x: 77, y: 653 },
      { text: "1.2 Do you have a solicitor?", x: 28, y: 600 },
      { text: "Yes", x: 77, y: 573 },
      { text: "No", x: 77, y: 543 },
      { text: "Section 2 - About you", x: 28, y: 480 },
      { text: "2.1 Full name of the applicant", x: 28, y: 450 },
      { text: "First name(s)", x: 57, y: 420 },
      { text: "Date of marriage", x: 57, y: 350 },
      { text: "Day", x: 57, y: 330 },
      { text: "Month", x: 157, y: 330 },
      { text: "Year", x: 257, y: 330 }
    ],
    textBoxes: [
      { name: "Text1", x: 57, y: 390, maxLength: 15 },
      { name: "Text2", x: 57, y: 362, maxLength: 15 },
      { name: "Day", x: 57, y: 300, width: 40 },
      { name: "Month", x: 157, y: 300, width: 40 },
      { name: "Year", x: 257, y: 300, width: 80 }
    ],
    checkboxes: [
      { name: "c1", x: 57, y: 680 },
      { name: "c2", x: 57, y: 650 },
      { name: "yes", x: 57, y: 570 },
      { name: "no", x: 57, y: 540 }
    ]
  },
  {
    texts: [
      { text: "2.2 Which court?", x: 28, y: 740 },
      { text: "Court name", x: 57, y: 720 },
      { text: "2.3 How will you pay?", x: 28, y: 640 },
      { text: "By card", x: 77, y: 613 },
      { text: "By cheque", x: 77, y: 583 }
    ],
    textBoxes: [{ name: "court", x: 57, y: 690 }],
    radios: [
      {
        name: "pay",
        options: [
          { value: "card", x: 57, y: 610 },
          { value: "cheque", x: 57, y: 580 }
        ]
      }
    ]
  }
];
