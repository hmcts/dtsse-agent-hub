import type ExcelJS from "exceljs";
import { cellText } from "./cells.ts";
import type { Bundle, Field, FormSpec } from "./schema.ts";
import { bundleSchema, fieldSchema, formSpecSchema } from "./schema.ts";
import { FIELD_COLUMN, isPageOrderExample, SIP } from "./sip-layout.ts";

const INPUT_TYPES: Record<string, Field["inputType"]> = {
  "text box": "text",
  textbox: "text",
  text: "text",
  "check box": "checkbox",
  checkbox: "checkbox",
  tick: "checkbox",
  date: "date",
  "qr code": "qr"
};

function inputTypeOf(text: string): Field["inputType"] {
  return INPUT_TYPES[text.trim().toLowerCase()] ?? "text";
}

function mandatoryOf(text: string): Field["mandatory"] {
  const t = text.trim().toLowerCase();
  if (t.startsWith("mandatory")) {
    return "mandatory";
  }
  if (t.startsWith("cond")) {
    return "conditional";
  }
  if (t === "") {
    return "not-read";
  }
  return "optional";
}

function handwritingOf(text: string): Field["handwriting"] {
  const t = text.trim().toLowerCase();
  if (t.startsWith("hand")) {
    return "handwritten";
  }
  if (t.startsWith("print")) {
    return "printed";
  }
  if (t === "both") {
    return "both";
  }
  return undefined;
}

function optional(text: string): string | undefined {
  return text.trim() === "" ? undefined : text;
}

function find(sheet: ExcelJS.Worksheet, from: number, test: (text: string) => boolean): number | undefined {
  for (let r = from; r <= sheet.rowCount; r++) {
    if (test(cellText(sheet.getCell(r, 1).value))) {
      return r;
    }
  }
  return undefined;
}

function readField(rows: string[][]): Field {
  const first = rows[0] ?? [];
  const col = (c: number, row = first) => row[c - 1] ?? "";
  const keys = rows.map((r) => col(FIELD_COLUMN.key, r).trim()).filter(Boolean);
  const mandatory = mandatoryOf(col(FIELD_COLUMN.mandatory));
  // A row nobody reads has no input type, which the sheet writes as NA.
  const inputType = mandatory === "not-read" && col(FIELD_COLUMN.inputType).trim() === "" ? "none" : inputTypeOf(col(FIELD_COLUMN.inputType));
  const named = rows.some((r) => col(FIELD_COLUMN.name, r).trim() !== (col(FIELD_COLUMN.description, r).split("\n")[0] ?? "").trim());
  const checkbox = inputType === "checkbox" && (keys.length > 1 || named);
  const emits = rows.flatMap((r) => {
    const cell = col(FIELD_COLUMN.value, r).trim();
    return cell === "" ? [] : cell.split("|").map((v) => ({ key: col(FIELD_COLUMN.key, r).trim(), value: v.trim() }));
  });
  const maxLength = Number(col(FIELD_COLUMN.maxLength));
  const sip = {
    tagName: optional(col(FIELD_COLUMN.tagName)),
    percentPopulated: optional(col(FIELD_COLUMN.percentPopulated)),
    classification: optional(col(FIELD_COLUMN.classification))
  };
  return fieldSchema.parse({
    id: optional(
      col(FIELD_COLUMN.id)
        .replace(/^#\d+$/, "")
        .replace(/#\d+$/, "")
    ),
    role: "field",
    label: col(FIELD_COLUMN.description) || col(FIELD_COLUMN.name),
    inputType,
    mandatory,
    keys,
    group: checkbox
      ? {
          kind: "xor",
          size: keys.length,
          options: rows
            .filter((r) => col(FIELD_COLUMN.key, r).trim() !== "")
            .map((r) => ({ key: col(FIELD_COLUMN.key, r).trim(), label: optional(col(FIELD_COLUMN.name, r)) }))
        }
      : undefined,
    pattern: optional(col(FIELD_COLUMN.pattern)),
    maxLength: Number.isInteger(maxLength) && maxLength > 0 ? maxLength : undefined,
    handwriting: handwritingOf(col(FIELD_COLUMN.handwriting)),
    validationRule: optional(col(FIELD_COLUMN.validationRule)),
    regex: optional(col(FIELD_COLUMN.regex)),
    defaultValue: optional(col(FIELD_COLUMN.defaultValue)),
    businessRules: optional(col(FIELD_COLUMN.businessRules)),
    emits: emits.length > 0 ? emits : undefined,
    sip: Object.values(sip).some(Boolean) ? sip : undefined
  });
}

function importFormSheet(sheet: ExcelJS.Worksheet): FormSpec | undefined {
  const h = SIP.headerRows;
  const at = (row: number) => optional(cellText(sheet.getCell(row, SIP.valueColumn).value))?.trim();
  const d = SIP.descriptionRows;
  const tableRow = find(sheet, SIP.firstFieldRow, (t) => t.startsWith("Expected Documents")) ?? SIP.expectedTableRow;

  const fieldRows: string[][] = [];
  for (let r = SIP.firstFieldRow; r < tableRow; r++) {
    const texts = Array.from({ length: SIP.fieldColumns }, (_, i) => cellText(sheet.getCell(r, i + 1).value));
    if (texts.some((t) => t.trim() !== "")) {
      fieldRows.push(texts);
    }
  }

  const fields: Field[] = [];
  let group: string[][] = [];
  const flush = () => {
    if (group.length > 0) {
      fields.push(readField(group));
    }
    group = [];
  };
  for (const row of fieldRows) {
    const id = row[FIELD_COLUMN.id - 1]?.trim() ?? "";
    const previous = group[0]?.[FIELD_COLUMN.id - 1]?.trim() ?? "";
    if (group.length > 0 && !(id !== "" && id === previous)) {
      flush();
    }
    group.push(row);
  }
  flush();

  const e = SIP.expectedDocuments;
  const expectedDocuments = [];
  for (let r = tableRow + 1; r < tableRow + SIP.expectedTableRows + 50; r++) {
    const name = cellText(sheet.getCell(r, e.nameColumn).value).trim();
    if (!name) {
      if (r > tableRow + SIP.expectedTableRows) {
        break;
      }
      continue;
    }
    expectedDocuments.push({
      order: Number(cellText(sheet.getCell(r, e.orderColumn).value)) || expectedDocuments.length + 1,
      name,
      identifier: optional(cellText(sheet.getCell(r, e.identifierColumn).value)),
      requirements: optional(cellText(sheet.getCell(r, e.requirementsColumn).value)),
      notes: optional(cellText(sheet.getCell(r, e.notesColumn).value))
    });
  }

  const form = {
    name: at(h.formName) ?? "",
    formType: at(h.formReference) ?? "",
    documentType: at(h.documentType),
    poBox: at(h.poBox),
    supplier: at(h.supplier),
    serviceName: at(h.serviceName),
    volumes: at(d.volumes),
    description: at(d.description),
    paymentHandling: at(d.paymentHandling),
    identifyingFeatures: at(d.identifyingFeatures),
    specialHandling: at(d.specialHandling)
  };
  const empty = fields.length === 0 && expectedDocuments.length === 0 && Object.values(form).every((v) => !v);
  if (empty) {
    return undefined;
  }
  return formSpecSchema.parse({
    form,
    sections: [{ id: "1", title: "", fields }],
    expectedDocuments
  });
}

/** The Page order sheet is workbook-wide: each key goes to the forms that have it, and keys no form has go to the first. */
function distributePageOrder(forms: FormSpec[], pages: { page: number; keys: string[] }[]): void {
  const [first] = forms;
  if (!first) {
    return;
  }
  const keysOf = forms.map((f) => new Set(f.sections.flatMap((s) => s.fields.flatMap((field) => field.keys))));
  const all = new Set(keysOf.flatMap((k) => [...k]));
  forms.forEach((form, i) => {
    form.pageOrder = pages
      .map((p) => ({ page: p.page, keys: p.keys.filter((k) => keysOf[i]?.has(k) || (form === first && !all.has(k))) }))
      .filter((p) => p.keys.length > 0);
  });
}

function readPageOrder(workbook: ExcelJS.Workbook): { page: number; keys: string[] }[] {
  const sheet = workbook.getWorksheet(SIP.pageOrder.sheet);
  if (!sheet) {
    return [];
  }
  const pages = new Map<number, { key: string; order: number }[]>();
  for (let r = SIP.pageOrder.firstRow; r <= sheet.rowCount; r++) {
    const page = Number(/\d+/.exec(cellText(sheet.getCell(r, 2).value))?.[0]);
    const key = cellText(sheet.getCell(r, 3).value).trim();
    if (isPageOrderExample(sheet, r) || !page || !key) {
      continue;
    }
    const order = Number(cellText(sheet.getCell(r, 4).value)) || (pages.get(page)?.length ?? 0) + 1;
    pages.set(page, [...(pages.get(page) ?? []), { key, order }]);
  }
  return [...pages.entries()].sort(([a], [b]) => a - b).map(([page, items]) => ({ page, keys: items.sort((a, b) => a.order - b.order).map((i) => i.key) }));
}

/** Reads every populated `Form n` tab of an Exela SIP workbook, with the Overview sheet's service details. */
export function importSip(workbook: ExcelJS.Workbook): Bundle {
  const forms = workbook.worksheets
    .filter((s) => SIP.formSheetPattern.test(s.name))
    .map((s) => importFormSheet(s))
    .filter((f): f is FormSpec => f !== undefined);

  distributePageOrder(forms, readPageOrder(workbook));

  const o = SIP.overview;
  const overview = workbook.getWorksheet(o.sheet);
  const at = (row: number) => optional(cellText(overview?.getCell(row, o.valueColumn).value))?.trim();
  const contacts = [];
  for (let i = 0; i < 4; i++) {
    const base = o.firstContactRow + i * 4;
    const cell = (j: number) => optional(cellText(overview?.getCell(base + j, o.contactColumn).value))?.trim();
    const contact = { name: cell(0), telephone: cell(1), email: cell(2), role: cell(3) };
    if (Object.values(contact).some(Boolean)) {
      contacts.push(contact);
    }
  }
  return bundleSchema.parse({
    overview: { serviceName: at(o.serviceName), completedBy: at(o.completedBy), verifiedBy: at(o.verifiedBy), signOffDate: at(o.signOffDate), contacts },
    forms
  });
}
