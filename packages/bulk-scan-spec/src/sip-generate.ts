import type ExcelJS from "exceljs";
import { cellText } from "./cells.ts";
import { valueSetFor } from "./emits.ts";
import type { Bundle, Field, FormSpec } from "./schema.ts";
import { allFields } from "./schema.ts";
import { FIELD_COLUMN, isPageOrderExample, SIP } from "./sip-layout.ts";
import { buildBlankTemplate } from "./sip-template.ts";

export interface SipRow {
  id: string;
  name: string;
  description: string;
  key: string;
  value: string;
  inputType: string;
  pattern: string;
  mandatory: string;
  maxLength: string;
  percentPopulated: string;
  handwriting: string;
  validationRule: string;
  regex: string;
  defaultValue: string;
  tagName: string;
  businessRules: string;
  classification: string;
}

const INPUT_TYPE_LABEL = { text: "Text box", checkbox: "Check box", date: "Date", qr: "QR code", none: "" } as const;
const MANDATORY_LABEL = { mandatory: "Mandatory", optional: "Optional", conditional: "Conditional", "not-read": "" } as const;
const HANDWRITING_LABEL = { handwritten: "Handwritten", printed: "Printed", both: "Both" } as const;

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "").trim();
}

/**
 * The strings the key may carry, separated by "|", with a trailing "|" when blank is also allowed. A tick box the sheet lists no
 * values for takes "true|false".
 */
function valueColumn(field: Field, key: string): string {
  const set = valueSetFor(field, key);
  if (!set) {
    return field.inputType === "checkbox" ? "true|false" : "";
  }
  if (set.allowed.length > 0) {
    return [...set.allowed, ...(set.blankAllowed ? [""] : [])].join("|");
  }
  // A bare "|" says "blank only" for a key of a tick-box field, where an empty cell would mean "true|false".
  return field.inputType === "checkbox" && set.blankAllowed ? "|" : "";
}

/** The SIP has no column for "these keys belong together", so a multi-key field with no id of its own repeats this marker plus a running number in the ID column. */
export const GROUP_MARKER = "#";

/** One SIP row per data file key: the SIP lists every key Exela must emit, where the transformation sheet lists questions. */
export function sipRowsFor(field: Field, rowId = field.id ?? ""): SipRow[] {
  if (field.role !== "field") {
    return [];
  }
  return field.keys.map((key) => {
    const option = field.group?.options.find((o) => o.key === key);
    return {
      id: rowId,
      name: option?.label ?? firstLine(field.label),
      description: field.label,
      key,
      value: valueColumn(field, key),
      inputType: INPUT_TYPE_LABEL[field.inputType],
      pattern: field.pattern ?? "",
      mandatory: MANDATORY_LABEL[field.mandatory],
      maxLength: field.maxLength === undefined ? "" : String(field.maxLength),
      percentPopulated: field.sip?.percentPopulated ?? "",
      handwriting: field.handwriting ? HANDWRITING_LABEL[field.handwriting] : "",
      validationRule: field.validationRule ?? "",
      regex: field.regex ?? "",
      defaultValue: field.defaultValue ?? "",
      tagName: field.sip?.tagName ?? "",
      businessRules: field.businessRules ?? "",
      classification: field.sip?.classification ?? ""
    };
  });
}

/**
 * Rows are grouped into fields by an identical ID on consecutive rows, so the ID written must tell fields apart: a field that repeats
 * the previous field's id gets "#2", "#3"… after it, and a multi-key field with no id gets "#n" alone. The importer strips both.
 */
export function sipRows(spec: FormSpec): SipRow[] {
  let grouped = 0;
  let previous: string | undefined;
  let run = 1;
  const rows: SipRow[] = [];
  for (const f of allFields(spec)) {
    if (f.role !== "field" || f.keys.length === 0) {
      continue;
    }
    let rowId = "";
    if (f.id !== undefined) {
      run = f.id === previous ? run + 1 : 1;
      previous = f.id;
      rowId = run > 1 ? `${f.id}${GROUP_MARKER}${run}` : f.id;
    } else {
      previous = undefined;
      rowId = f.keys.length > 1 ? `${GROUP_MARKER}${++grouped}` : "";
    }
    rows.push(...sipRowsFor(f, rowId));
  }
  return rows;
}

interface WithValidations {
  dataValidations: { model: Record<string, { formulae?: unknown[] }> };
}

/** exceljs orders sheets by this property but does not declare it. */
interface Orderable {
  orderNo: number;
}

function copyCell(from: ExcelJS.Cell, to: ExcelJS.Cell, withValue: boolean): void {
  to.style = { ...from.style };
  if (withValue && !(from.isMerged && from.master !== from)) {
    to.value = from.value;
  }
}

/** A new Form tab laid out like `source`: widths, heights, cell styles, values and merges. */
export function cloneFormSheet(workbook: ExcelJS.Workbook, source: ExcelJS.Worksheet, name: string): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(name);
  source.columns.forEach((column, i) => {
    if (column.width) {
      sheet.getColumn(i + 1).width = column.width;
    }
  });
  const lastRow = SIP.expectedTableRow + SIP.expectedTableRows - 1;
  for (let r = 1; r <= lastRow; r++) {
    const height = source.getRow(r).height;
    if (height) {
      sheet.getRow(r).height = height;
    }
    for (let c = 1; c <= SIP.fieldColumns; c++) {
      copyCell(source.getCell(r, c), sheet.getCell(r, c), true);
    }
  }
  for (const range of source.model.merges) {
    sheet.mergeCells(range);
  }
  const target = (sheet as unknown as { dataValidations: { add(address: string, validation: unknown): void } }).dataValidations;
  for (const [address, validation] of Object.entries((source as unknown as WithValidations).dataValidations.model)) {
    // The Standard Fields dropdowns point at a workbook that is not shipped, so they are not carried over.
    if (!validation.formulae?.some((f) => /StdFields/.test(String(f)))) {
      target.add(address, validation);
    }
  }
  return sheet;
}

/** The Expected Documents table where the template puts it; a Form tab that has already been filled, and so moved it, is refused. */
function templateTable(sheet: ExcelJS.Worksheet): { row: number; height: number } {
  if (!cellText(sheet.getCell(SIP.expectedTableRow, 1).value).startsWith("Expected Documents")) {
    throw new Error(
      `"${sheet.name}" has no Expected Documents table at row ${SIP.expectedTableRow}: generate from the template, not from a SIP already generated`
    );
  }
  return { row: SIP.expectedTableRow, height: SIP.expectedTableRows };
}

/**
 * Puts the Expected Documents table at `to`, `newHeight` rows tall (a header and its entries): its merges are
 * undone and redone, its data validations move with it, and the rows it leaves behind take the field table's style.
 */
function moveExpectedTable(sheet: ExcelJS.Worksheet, from: { row: number; height: number }, to: number, newHeight: number): void {
  if (from.row === to && from.height === newHeight) {
    return;
  }
  const bodyStyle = (c: number) => ({ ...sheet.getCell(SIP.firstFieldRow, c).style });
  const header: { value: ExcelJS.CellValue; style: Partial<ExcelJS.Style> }[] = [];
  const entry: Partial<ExcelJS.Style>[] = [];
  for (let c = 1; c <= SIP.fieldColumns; c++) {
    const top = sheet.getCell(from.row, c);
    header.push({ value: top.isMerged && top.master !== top ? null : top.value, style: { ...top.style } });
    entry.push({ ...sheet.getCell(from.row + Math.min(1, from.height - 1), c).style });
  }
  const inTable = (range: string) => {
    const row = Number(/\d+/.exec(range)?.[0]);
    return row >= from.row && row < from.row + from.height;
  };
  for (const range of sheet.model.merges.filter(inTable)) {
    sheet.unMergeCells(range);
  }
  const validations = (sheet as unknown as WithValidations & { dataValidations: { add(a: string, v: unknown): void } }).dataValidations;
  const moved = Object.entries(validations.model).filter(([address]) => inTable(address));
  for (const [address] of moved) {
    delete validations.model[address];
  }
  const clearFrom = Math.min(from.row, to);
  const clearTo = Math.max(from.row + from.height, to + newHeight) - 1;
  for (let r = clearFrom; r <= clearTo; r++) {
    for (let c = 1; c <= SIP.fieldColumns; c++) {
      const cell = sheet.getCell(r, c);
      cell.value = null;
      cell.style = bodyStyle(c);
    }
  }
  for (let r = to; r < to + newHeight; r++) {
    for (let c = 1; c <= SIP.fieldColumns; c++) {
      const cell = sheet.getCell(r, c);
      cell.style = (r === to ? header[c - 1]?.style : entry[c - 1]) ?? {};
      if (r === to) {
        cell.value = header[c - 1]?.value ?? null;
      }
    }
    for (const range of [`F${r}:H${r}`, `I${r}:J${r}`, `K${r}:N${r}`]) {
      sheet.mergeCells(range);
    }
  }
  sheet.mergeCells(`A${to}:A${to + newHeight - 1}`);
  for (const [address, validation] of moved) {
    validations.add(
      address.replace(/\d+/, (n) => String(Number(n) + to - from.row)),
      validation
    );
  }
}

function clearRange(sheet: ExcelJS.Worksheet, fromRow: number, toRow: number, columns: number): void {
  for (let r = fromRow; r <= toRow; r++) {
    for (let c = 1; c <= columns; c++) {
      const cell = sheet.getCell(r, c);
      // Writing to a merged cell's follower overwrites its master.
      if (!cell.isMerged || cell.master === cell) {
        cell.value = null;
      }
    }
  }
}

/** A yyyy-mm-dd value goes back as an Excel date, keeping the cell's number format (or dd/mm/yyyy where it has none). */
function writeDateOrText(cell: ExcelJS.Cell, value: string | undefined): void {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!m) {
    cell.value = text(value);
    return;
  }
  cell.value = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (!cell.numFmt || cell.numFmt === "General") {
    cell.numFmt = "dd/mm/yyyy";
  }
}

function text(value: string | undefined): string | null {
  return value ? value : null;
}

export function fillFormSheet(sheet: ExcelJS.Worksheet, spec: FormSpec, overview?: Bundle["overview"]): void {
  const { form } = spec;
  const rows = sipRows(spec);
  const capacity = SIP.expectedTableRow - SIP.firstFieldRow;
  const tableStart = SIP.expectedTableRow + Math.max(0, rows.length - capacity);
  const docs = [...spec.expectedDocuments].sort((a, b) => a.order - b.order);
  moveExpectedTable(sheet, templateTable(sheet), tableStart, 1 + Math.max(SIP.expectedTableRows - 1, docs.length));

  const h = SIP.headerRows;
  const set = (row: number, value: string | undefined) => {
    sheet.getCell(row, SIP.valueColumn).value = text(value);
  };
  set(h.serviceName, form.serviceName ?? overview?.serviceName);
  set(h.poBox, form.poBox);
  set(h.documentType, form.documentType);
  set(h.formName, form.name);
  set(h.formReference, form.formType);
  set(h.supplier, form.supplier);
  const d = SIP.descriptionRows;
  set(d.volumes, form.volumes);
  set(d.description, form.description);
  set(d.paymentHandling, form.paymentHandling);
  set(d.identifyingFeatures, form.identifyingFeatures);
  set(d.specialHandling, form.specialHandling);
  const so = SIP.signOff;
  sheet.getCell(so.completedBy, so.column).value = text(overview?.completedBy);
  sheet.getCell(so.verifiedBy, so.column).value = text(overview?.verifiedBy);
  writeDateOrText(sheet.getCell(so.signOffDate, so.column), overview?.signOffDate);

  clearRange(sheet, SIP.firstFieldRow, tableStart - 1, SIP.fieldColumns);
  rows.forEach((row, i) => {
    const r = SIP.firstFieldRow + i;
    for (const [name, col] of Object.entries(FIELD_COLUMN)) {
      const raw = row[name as keyof SipRow];
      const cell = sheet.getCell(r, col);
      cell.value = col === FIELD_COLUMN.maxLength && raw !== "" ? Number(raw) : text(raw);
    }
  });

  const e = SIP.expectedDocuments;
  docs.forEach((doc, i) => {
    const r = tableStart + 1 + i;
    sheet.getCell(r, e.orderColumn).value = doc.order;
    sheet.getCell(r, e.nameColumn).value = text(doc.name);
    sheet.getCell(r, e.identifierColumn).value = text(doc.identifier);
    sheet.getCell(r, e.requirementsColumn).value = text(doc.requirements);
    sheet.getCell(r, e.notesColumn).value = text(doc.notes);
  });
}

function fillPageOrder(workbook: ExcelJS.Workbook, forms: FormSpec[]): void {
  const sheet = workbook.getWorksheet(SIP.pageOrder.sheet);
  if (!sheet) {
    return;
  }
  const isExample = (r: number) => isPageOrderExample(sheet, r);
  for (let r = SIP.pageOrder.firstRow; r <= Math.max(sheet.rowCount, SIP.pageOrder.firstRow); r++) {
    if (isExample(r)) {
      continue;
    }
    for (let c = 1; c <= 4; c++) {
      sheet.getCell(r, c).value = null;
    }
  }
  let row = SIP.pageOrder.firstRow;
  const written = new Set<string>();
  const perPage = new Map<number, number>();
  for (const form of forms) {
    for (const page of [...form.pageOrder].sort((a, b) => a.page - b.page)) {
      for (const key of page.keys) {
        const id = `${page.page}|${key}`;
        if (written.has(id)) {
          continue;
        }
        written.add(id);
        while (isExample(row)) {
          row++;
        }
        sheet.getCell(row, 2).value = `Page ${page.page}`;
        sheet.getCell(row, 3).value = key;
        perPage.set(page.page, (perPage.get(page.page) ?? 0) + 1);
        sheet.getCell(row, 4).value = perPage.get(page.page);
        row++;
      }
    }
  }
}

function fillOverview(workbook: ExcelJS.Workbook, overview: Bundle["overview"], forms: FormSpec[]): void {
  const o = SIP.overview;
  const sheet = workbook.getWorksheet(o.sheet);
  if (sheet) {
    const set = (row: number, value: string | undefined) => {
      sheet.getCell(row, o.valueColumn).value = text(value);
    };
    set(o.serviceName, overview?.serviceName ?? forms[0]?.form.serviceName);
    set(o.completedBy, overview?.completedBy);
    set(o.verifiedBy, overview?.verifiedBy);
    writeDateOrText(sheet.getCell(o.signOffDate, o.valueColumn), overview?.signOffDate);
    // All four contact blocks are written, so a block the spec does not fill is cleared.
    for (let i = 0; i < 4; i++) {
      const contact = overview?.contacts[i];
      [contact?.name, contact?.telephone, contact?.email, contact?.role].forEach((value, j) => {
        sheet.getCell(o.firstContactRow + i * 4 + j, o.contactColumn).value = text(value);
      });
    }
  }
  const ramp = workbook.getWorksheet(SIP.rampUp.sheet);
  if (ramp) {
    forms.forEach((spec, i) => {
      ramp.getCell(SIP.rampUp.firstFormRow + i, 1).value = spec.form.name || `Form ${i + 1}`;
    });
    // Rows past the last form go back to the template's own placeholders.
    for (let i = forms.length; i < SIP.rampUp.placeholders; i++) {
      ramp.getCell(SIP.rampUp.firstFormRow + i, 1).value = `Form ${i + 1}`;
    }
  }
}

/** The field-name dropdowns point at a named range in Exela's Standard Fields workbook, which is not shipped with the template. */
function dropDanglingStandardFields(workbook: ExcelJS.Workbook): void {
  for (const sheet of workbook.worksheets) {
    const { model } = (sheet as unknown as WithValidations).dataValidations;
    for (const [address, validation] of Object.entries(model)) {
      if (validation.formulae?.some((f) => /StdFields/.test(String(f)))) {
        delete model[address];
      }
    }
  }
  for (const { name, ranges } of workbook.definedNames.model) {
    if (!/Standard\s?Fields|StdFields/.test(name)) {
      continue;
    }
    for (const range of ranges) {
      workbook.definedNames.remove(range, name);
    }
  }
}

/**
 * Fills the supplier's template rather than building a workbook from nothing, so everything the spec does not own
 * (the version table, the ramp-up and exceptions sheets, styles, column widths, merges) comes out as Exela issued it.
 * Without a template file a structurally equivalent blank is built.
 */
export function generateSipWorkbook(bundle: Bundle, template?: ExcelJS.Workbook): ExcelJS.Workbook {
  const workbook = template ?? buildBlankTemplate();
  const formSheets = workbook.worksheets.filter((s) => SIP.formSheetPattern.test(s.name));
  if (formSheets.length > bundle.forms.length) {
    throw new Error(
      `the template has ${formSheets.length} form tabs and the spec ${bundle.forms.length} forms: use a template with no more form tabs than forms`
    );
  }
  const base = formSheets[0];
  if (!base) {
    throw new Error("the template has no 'Form n' sheet to build the form tabs from");
  }
  const pristine = bundle.forms.length > 1 ? cloneFormSheet(workbook, base, "__pristine") : undefined;
  dropDanglingStandardFields(workbook);

  // New tabs go after the last form tab the workbook already has, whatever number of tabs that is.
  let lastFormOrder = Math.max(...workbook.worksheets.filter((s) => SIP.formSheetPattern.test(s.name)).map((s) => (s as unknown as Orderable).orderNo));
  bundle.forms.forEach((spec, i) => {
    const name = `Form ${i + 1}`;
    let sheet = workbook.getWorksheet(name);
    if (!sheet) {
      if (!pristine) {
        throw new Error("no pristine form sheet to clone");
      }
      sheet = cloneFormSheet(workbook, pristine, name);
      lastFormOrder += 0.01;
      (sheet as unknown as Orderable).orderNo = lastFormOrder;
    }
    fillFormSheet(sheet, spec, bundle.overview);
  });
  if (pristine) {
    workbook.removeWorksheet(pristine.id);
  }
  fillOverview(workbook, bundle.overview, bundle.forms);
  fillPageOrder(workbook, bundle.forms);
  return workbook;
}
