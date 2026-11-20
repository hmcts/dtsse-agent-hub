import { readFileSync } from "node:fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface Widget {
  page: number;
  name: string;
  kind: "text" | "checkbox" | "radio";
  /** [left, bottom, right, top] in PDF points. */
  rect: [number, number, number, number];
  maxLength?: number;
  multiline: boolean;
  /** The value a ticked checkbox or selected radio button carries. */
  option?: string;
  tooltip?: string;
}

export interface Line {
  page: number;
  x0: number;
  x1: number;
  /** Baseline. */
  y: number;
  /** Height of the tallest text on the line. */
  height: number;
  text: string;
}

export interface PdfContent {
  pageCount: number;
  widgets: Widget[];
  lines: Line[];
}

/** Text items on one baseline closer than this are one line; a wider gap starts a new one, so a margin note beside a question stays apart from it. */
const SAME_ROW = 2.5;
const COLUMN_GAP = 25;

interface Item {
  x: number;
  y: number;
  width: number;
  height: number;
  str: string;
}

function rowsOf(items: Item[], page: number): Line[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  let row: Item[] = [];
  const flush = (): void => {
    row.sort((a, b) => a.x - b.x);
    let current: Line | undefined;
    for (const item of row) {
      if (current && item.x - current.x1 <= COLUMN_GAP) {
        current.text += item.x - current.x1 > 1 ? ` ${item.str}` : item.str;
        current.x1 = Math.max(current.x1, item.x + item.width);
        current.height = Math.max(current.height, item.height);
      } else {
        current = { page, x0: item.x, x1: item.x + item.width, y: row[0]?.y ?? item.y, height: item.height, text: item.str };
        lines.push(current);
      }
    }
    row = [];
  };
  for (const item of sorted) {
    if (row.length > 0 && Math.abs((row[0]?.y ?? 0) - item.y) > SAME_ROW) {
      flush();
    }
    row.push(item);
  }
  flush();
  return lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() })).filter((l) => l.text !== "");
}

/** The form fields (text boxes, checkboxes, radio buttons) and the text layer of a PDF. Other field types are not read. */
export async function extractPdf(source: string | Uint8Array): Promise<PdfContent> {
  const task = getDocument({ data: typeof source === "string" ? new Uint8Array(readFileSync(source)) : new Uint8Array(source), verbosity: 0 });
  const doc = await task.promise;
  try {
    const widgets: Widget[] = [];
    const lines: Line[] = [];
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      for (const a of await page.getAnnotations()) {
        if (a.subtype !== "Widget" || a.pushButton) {
          continue;
        }
        const kind = a.fieldType === "Tx" ? "text" : a.fieldType === "Btn" ? (a.radioButton ? "radio" : "checkbox") : undefined;
        if (!kind) {
          continue;
        }
        const option = (a.radioButton ? a.buttonValue : a.exportValue) as string | undefined;
        widgets.push({
          page: number,
          name: String(a.fieldName ?? ""),
          kind,
          rect: a.rect as [number, number, number, number],
          ...(a.maxLen ? { maxLength: a.maxLen as number } : {}),
          multiline: Boolean(a.multiLine),
          ...(option ? { option } : {}),
          ...(a.alternativeText ? { tooltip: String(a.alternativeText) } : {})
        });
      }
      const content = await page.getTextContent();
      const items = content.items.flatMap((i) =>
        "str" in i && i.str.trim() !== "" ? [{ x: i.transform[4] as number, y: i.transform[5] as number, width: i.width, height: i.height, str: i.str }] : []
      );
      lines.push(...rowsOf(items, number));
    }
    return { pageCount: doc.numPages, widgets, lines };
  } finally {
    await task.destroy();
  }
}
