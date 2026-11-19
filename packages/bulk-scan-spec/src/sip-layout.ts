/** Cell positions in the Exela Service Implementation Pack V3.2 workbook. */
export const SIP = {
  formSheetPattern: /^Form \d+$/,
  headerRows: { serviceName: 6, poBox: 7, documentType: 8, formName: 9, formReference: 10, supplier: 11 },
  valueColumn: 2,
  signOff: { column: 13, completedBy: 4, verifiedBy: 5, signOffDate: 6 },
  descriptionRows: { volumes: 16, description: 18, paymentHandling: 20, identifyingFeatures: 22, specialHandling: 24 },
  fieldHeaderRow: 27,
  firstFieldRow: 28,
  fieldColumns: 17,
  expectedTableRow: 114,
  expectedTableRows: 6,
  expectedDocuments: { orderColumn: 2, nameColumn: 6, identifierColumn: 9, requirementsColumn: 11, notesColumn: 15 },
  pageOrder: { sheet: "Page order", headerRow: 2, firstRow: 3 },
  overview: { sheet: "Overview", valueColumn: 3, serviceName: 4, completedBy: 5, verifiedBy: 6, signOffDate: 7, firstContactRow: 8, contactColumn: 4 },
  rampUp: { sheet: "Ramp up volumes", firstFormRow: 3, placeholders: 5 }
} as const;

export const FIELD_HEADERS = [
  "ID",
  "Field name",
  "Description ",
  "Data File Key Name",
  "Data File  Value Name",
  "Input Type",
  "Input Pattern / Validation",
  "Mandatory / Optional",
  "Max Field Length",
  "% Populated",
  "Handwritten or Printed?",
  "Validation Rule",
  "Regular Expression",
  "Default Value",
  "Tag Name",
  "Business Rules",
  "Field classification\nExela use only"
] as const;

/** The columns of a field row, in sheet order. */
export const FIELD_COLUMN = {
  id: 1,
  name: 2,
  description: 3,
  key: 4,
  value: 5,
  inputType: 6,
  pattern: 7,
  mandatory: 8,
  maxLength: 9,
  percentPopulated: 10,
  handwriting: 11,
  validationRule: 12,
  regex: 13,
  defaultValue: 14,
  tagName: 15,
  businessRules: 16,
  classification: 17
} as const;

export const FORM_SHEET_MERGES = [
  "A1:O2",
  "A4:J4",
  "A15:A16",
  "B15:O15",
  "B16:O16",
  "A17:A18",
  "B17:O17",
  "B18:O18",
  "A19:A20",
  "B19:O19",
  "B20:O20",
  "A21:A22",
  "B21:O21",
  "B22:O22",
  "A23:A24",
  "B23:O23",
  "B24:O24",
  "A114:A119",
  ...[114, 115, 116, 117, 118, 119].flatMap((r) => [`F${r}:H${r}`, `I${r}:J${r}`, `K${r}:N${r}`])
];

export const OVERVIEW_MERGES = [
  "A1:U2",
  "A4:B4",
  "C4:G4",
  "A5:B5",
  "C5:G5",
  "A6:B6",
  "C6:G6",
  "A7:B7",
  "C7:G7",
  "A8:B23",
  ...Array.from({ length: 16 }, (_, i) => `D${i + 8}:G${i + 8}`)
];
