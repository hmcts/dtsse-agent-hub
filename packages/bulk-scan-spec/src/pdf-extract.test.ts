import { describe, expect, it } from "vitest";
import { makePdf, SAMPLE_FORM } from "./__fixtures__/make-pdf.ts";
import { extractPdf } from "./pdf-extract.ts";

describe("extractPdf", () => {
  it("should read text boxes, checkboxes and radio buttons with their page and size", async () => {
    const { widgets, pageCount } = await extractPdf(await makePdf("sample", SAMPLE_FORM));
    expect(pageCount).toBe(2);
    expect(widgets.filter((w) => w.kind === "checkbox")).toHaveLength(4);
    expect(widgets.filter((w) => w.kind === "radio").map((w) => [w.name, w.option, w.page])).toEqual([
      ["pay", "card", 2],
      ["pay", "cheque", 2]
    ]);
    const first = widgets.find((w) => w.name === "Text1");
    expect(first).toMatchObject({ kind: "text", page: 1, maxLength: 15 });
    expect(first?.rect.map(Math.round)).toEqual([57, 390, 258, 411]);
  });

  it("should join text on one baseline into a line and keep a distant column apart", async () => {
    const path = await makePdf("lines", [
      {
        texts: [
          { text: "2.3", x: 28, y: 700 },
          { text: "Town or city", x: 57, y: 700 },
          { text: "Note 2.3: margin", x: 428, y: 700 }
        ]
      }
    ]);
    const { lines } = await extractPdf(path);
    expect(lines.map((l) => l.text)).toEqual(["2.3 Town or city", "Note 2.3: margin"]);
  });

  it("should find no fields when the PDF has none", async () => {
    const { widgets, lines } = await extractPdf(await makePdf("flat", [{ texts: [{ text: "A printed form", x: 40, y: 700 }] }]));
    expect(widgets).toEqual([]);
    expect(lines[0]?.text).toBe("A printed form");
  });
});
