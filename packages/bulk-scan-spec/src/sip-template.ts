import ExcelJS from "exceljs";
import { FIELD_HEADERS, FORM_SHEET_MERGES, OVERVIEW_MERGES, SIP } from "./sip-layout.ts";

const THIN = { style: "thin" as const };
const BOX = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const TITLE = "HMCTS Service Implementation Template v0.3";

function boxed(sheet: ExcelJS.Worksheet, range: string): void {
  const [from, to] = range.split(":");
  if (!from || !to) {
    return;
  }
  const a = sheet.getCell(from);
  const b = sheet.getCell(to);
  for (let r = Number(a.row); r <= Number(b.row); r++) {
    for (let c = Number(a.col); c <= Number(b.col); c++) {
      sheet.getCell(r, c).border = BOX;
    }
  }
}

function overview(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet(SIP.overview.sheet);
  sheet.getCell("A1").value = TITLE;
  const labels: [string, string][] = [
    ["A4", "Service Name"],
    ["A5", "Completed By"],
    ["A6", "Verified By"],
    ["A7", "Sign-off Date"],
    ["A8", "Key Contacts"]
  ];
  for (const [address, text] of labels) {
    sheet.getCell(address).value = text;
  }
  const roles = ["Name", "Telephone", "Email", "Role"];
  for (let i = 0; i < 16; i++) {
    sheet.getCell(8 + i, 3).value = roles[i % 4];
  }
  for (const range of OVERVIEW_MERGES) {
    sheet.mergeCells(range);
  }
  for (let r = 4; r <= 23; r++) {
    sheet.getCell(r, 3).border = BOX;
  }
  sheet.getColumn(1).width = 14;
  sheet.getColumn(3).width = 24;
}

function formSheet(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet("Form 1");
  sheet.getCell("A1").value = TITLE;
  sheet.getCell("A4").value = "Below to be completed per form required for capture. Please create a new tab for additional formsets";
  sheet.getCell("A5").value = "HMCTs";
  sheet.getCell("L4").value = "Completed By";
  sheet.getCell("L5").value = "Verified By";
  sheet.getCell("L6").value = "Sign-off Date";
  const header: [number, string][] = [
    [6, "Service Name"],
    [7, "PO Box"],
    [8, "Document Type"],
    [9, "Form Name"],
    [10, "Form Reference"],
    [11, "Supplier"],
    [12, "package_id"],
    [13, "burn_Number"]
  ];
  for (const [row, text] of header) {
    sheet.getCell(row, 1).value = text;
  }
  sheet.getCell("B12").value = "Filled by Exela (Unique identifier for the paper envelope / paper package which contained the document being scanned)";
  sheet.getCell("B13").value = "Filled by Exela (Unique Identifier for each scanned artefact)";
  const blocks: [number, string][] = [
    [15, "Volumes"],
    [17, "Form Description"],
    [19, "Payment handling"],
    [21, "Identifying Features"],
    [23, "Special Handling Requirements"]
  ];
  for (const [row, text] of blocks) {
    sheet.getCell(row, 1).value = text;
  }
  sheet.getCell("B15").value =
    "Please provide expected full monthly volumes following ramp up (recorded in separate tab) including any future increases/decreases";
  sheet.getCell("B17").value = "Please record the purpose of the form";
  sheet.getCell("B19").value =
    "Please confirm whether there is a fee and pay requirement for payments received via post. If not, please record how payments received through the post should be handled";
  sheet.getCell("B21").value = "Please outline any specific identifying features for this form e.g. barcodes";
  sheet.getCell("B23").value =
    "Please record any special handling requirements for this form or associated documents which are different to the requirements set out in the BRD";
  FIELD_HEADERS.forEach((text, i) => {
    const cell = sheet.getCell(SIP.fieldHeaderRow, i + 1);
    cell.value = text;
    cell.font = { bold: true };
    cell.alignment = { wrapText: true, vertical: "middle", horizontal: "center" };
  });
  sheet.getRow(SIP.fieldHeaderRow).height = 30;
  sheet.getCell(SIP.expectedTableRow, 1).value = "Expected Documents per envelope\n\nPlease complete table in scan order";
  const table: [number, string][] = [
    [2, "Scan Order"],
    [6, "Name"],
    [9, "Identifier"],
    [11, "Requirements"],
    [15, "Notes"]
  ];
  for (const [col, text] of table) {
    sheet.getCell(SIP.expectedTableRow, col).value = text;
  }
  for (const range of FORM_SHEET_MERGES) {
    sheet.mergeCells(range);
  }
  boxed(sheet, "B6:B11");
  boxed(sheet, "M4:M6");
  for (let r = SIP.firstFieldRow; r < SIP.expectedTableRow; r++) {
    boxed(sheet, `A${r}:Q${r}`);
  }
  boxed(sheet, `A${SIP.expectedTableRow}:O${SIP.expectedTableRow + SIP.expectedTableRows - 1}`);
  const widths = [8, 28, 40, 28, 18, 14, 18, 14, 10, 10, 14, 24, 20, 14, 14, 36, 18];
  widths.forEach((w, i) => {
    sheet.getColumn(i + 1).width = w;
  });
  sheet.getColumn(1).width = 14;
}

function otherSheets(workbook: ExcelJS.Workbook): void {
  const ramp = workbook.addWorksheet(SIP.rampUp.sheet);
  ramp.getCell("A1").value = "Ramp up volumes:";
  ramp.getCell("A2").value = "Form Name:\nAmend/Delete as appropriate";
  for (let w = 1; w <= 12; w++) {
    ramp.getCell(2, 1 + w).value = `Week ${w}`;
  }
  for (let i = 0; i < 5; i++) {
    ramp.getCell(SIP.rampUp.firstFormRow + i, 1).value = `Form ${i + 1}`;
  }
  workbook.addWorksheet("Cherished").getCell("A1").value =
    "Please record any additional cherished items not already included in the Cherished Item list in the BRD";
  const exceptions = workbook.addWorksheet("Exceptions");
  exceptions.getCell("A1").value = "Please detail below  any situations which would require a handoff to a legacy site by Exela:";
  exceptions.getCell("C1").value = "Legacy site address:";
}

function pageOrder(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet(SIP.pageOrder.sheet);
  const headers = ["", "Page ", "SIP From  / Metafields", "Expected Field Order "];
  headers.forEach((text, i) => {
    sheet.getCell(SIP.pageOrder.headerRow, i + 1).value = text;
  });
}

/** A workbook with the structure of the Exela V3.2 template, for use when the supplier's own file is not to hand. */
export function buildBlankTemplate(): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  overview(workbook);
  otherSheets(workbook);
  formSheet(workbook);
  pageOrder(workbook);
  return workbook;
}
