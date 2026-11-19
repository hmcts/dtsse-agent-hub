import ExcelJS from "exceljs";

const HEADER = [
  "ID",
  "Field name",
  "Data Type",
  "Mandatory / Optional",
  "Validation Rule",
  "Default Value",
  "Description (OCR -> MetaData JSON File Creation)",
  "MetaData Tag Name",
  "Comments / Business Rules",
  "CCD Casefield ID",
  "CCD Transformation + Validation Logic",
  "Case Path (success/warning/exception)"
];

const LABEL = (text: string): string[] => ["", text, "NA", "Do not read", "NA", "", "NA", "", "", "N/A. This is a label", "", ""];

const TEXT = (key: string): string => `"metadata_field_name": "${key}"\n"metadata_field_value": ""`;
const TICK = (key: string): string =>
  `if ticked\n"metadata_field_name": "${key}"\n"metadata_field_value": "true"\nif not ticked\n"metadata_field_name": "${key}"\n"metadata_field_value": "false"`;

const ROWS: string[][] = [
  LABEL("Section 1 - Your Application"),
  [
    "1.1",
    "What application are you making?\n[]Divorce\n[]Dissolution",
    "XoR (2)",
    "Mandatory",
    "If field is empty validation status = warning",
    "",
    `${TICK("applicationForDivorce")}\n${TICK("applicationForDissolution")}`,
    "applicationForDivorce\napplicationForDissolution",
    "If not selected default to Divorce",
    "divorceOrDissolution",
    "1) If applicationForDivorce = true, divorceOrDissolution = divorce\n\nELSE IF\n\n2) If applicationForDissolution = true, divorceOrDissolution = dissolution\n\nELSE\n\n3) divorceOrDissolution = divorce",
    "1) = success\n\n2) = success\n\n3) = warning\n\nRecord cannot go into exception based on this attribute"
  ],
  LABEL("Section 2 - About you"),
  [
    "2.1",
    "First name(s)",
    "text",
    "Mandatory",
    "",
    "",
    TEXT("applicantFirstName"),
    "applicantFirstName",
    "",
    "applicant1FirstName",
    "applicant1FirstName = applicantFirstName (just pass it through)",
    "Success"
  ],
  [
    "2.2",
    "Address\nBuilding and street",
    "Text",
    "Optional",
    "",
    "",
    TEXT("applicantBuildingAndStreet"),
    "applicantBuildingAndStreet",
    "",
    "applicant1HomeAddress",
    "Populate these separate address fields (from the metadata json file) into the one address field (applicant1HomeAddress) that we have on CCD",
    "Success"
  ],
  [
    "",
    "Town or city",
    "Text",
    "Optional",
    "",
    "",
    TEXT("applicantTownOrCity"),
    "applicantTownOrCity",
    "",
    "applicant1HomeAddress",
    "Populate these separate address fields (from the metadata json file) into the one address field (applicant1HomeAddress) that we have on CCD",
    "Success"
  ],
  [
    "2.3",
    "Date of marriage",
    "date",
    "Mandatory",
    "",
    "",
    `${TEXT("marriageDay")}\n${TEXT("marriageMonth")}\n${TEXT("marriageYear")}`,
    "marriageDay\nmarriageMonth\nmarriageYear",
    "",
    "marriageDate",
    "Odd date handling described in prose only",
    "1) Warning\n\n2) Success"
  ]
];

/** A small transformation sheet with a section, an XoR group, a pass-through, an address compose and one row of logic that cannot be parsed. */
export function buildMiniD8(): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("X1 BSS");
  sheet.addRow(HEADER);
  for (const row of ROWS) {
    sheet.addRow(row);
  }
  sheet.mergeCells("J6:J7");
  sheet.mergeCells("K6:K7");
  sheet.mergeCells("L6:L7");
  return workbook;
}
