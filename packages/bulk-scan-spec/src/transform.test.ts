import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildMiniD8 } from "./__fixtures__/d8-mini.ts";
import { sheetWith, sheetWith as sw6, TRANSFORM_HEADER as TH6, YES_NO } from "./__fixtures__/helpers.ts";
import { valueSets } from "./emits.ts";
import { classify } from "./round-trip-run.ts";
import { diffSheets } from "./roundtrip.ts";
import { fieldSchema as fs6, formSpecSchema as fss6 } from "./schema.ts";
import { generateTransformWorkbook as gen6, generateTransformWorkbook, transformSheetName } from "./transform-generate.ts";
import { importTransformSheet as imp6, importTransformSheet } from "./transform-import.ts";
import { cosmeticallyEqual } from "./transform-render.ts";

function mini() {
  const sheet = buildMiniD8().worksheets[0];
  if (!sheet) {
    throw new Error("no sheet");
  }
  return importTransformSheet(sheet);
}

/** The differences between a sheet and the sheet regenerated from its imported spec. */
async function differences(original: ExcelJS.Worksheet) {
  const { spec } = importTransformSheet(original);
  return classify(diffSheets(original, await reload(generateTransformWorkbook(spec)), 12));
}

async function reload(workbook: ExcelJS.Workbook): Promise<ExcelJS.Worksheet> {
  const out = new ExcelJS.Workbook();
  await out.xlsx.load((await workbook.xlsx.writeBuffer()) as ArrayBuffer);
  const [sheet] = out.worksheets;
  if (!sheet) {
    throw new Error("no sheet");
  }
  return sheet;
}

describe("importTransformSheet", () => {
  it("should name the form after the sheet and split sections when a 'Section n' label row appears", () => {
    const { spec } = mini();
    expect(spec.form).toMatchObject({ name: "X1", formType: "X1" });
    expect(spec.sections.map((s) => [s.id, s.title, s.fields.length])).toEqual([
      ["1", "Section 1 - Your Application", 1],
      ["2", "Section 2 - About you", 4]
    ]);
    expect(spec.sections[0]?.heading?.role).toBe("label");
  });

  it("should read an XoR row into a group with option labels and its logic into rules when the row has several keys", () => {
    const field = mini().spec.sections[0]?.fields[0];
    expect(field).toMatchObject({
      id: "1.1",
      inputType: "checkbox",
      mandatory: "mandatory",
      keys: ["applicationForDivorce", "applicationForDissolution"],
      ccd: ["divorceOrDissolution"],
      neverExceeds: "warning",
      group: {
        kind: "xor",
        size: 2,
        options: [
          { key: "applicationForDivorce", label: "Divorce" },
          { key: "applicationForDissolution", label: "Dissolution" }
        ]
      }
    });
    expect(field?.rules).toHaveLength(3);
    expect(field?.rules[2]).toMatchObject({ otherwise: true, outcome: "warning" });
  });

  it("should group rows into a compose when they share a CCD field, naming the address parts", () => {
    const { spec } = mini();
    expect(spec.composes).toContainEqual({
      ccd: "applicant1HomeAddress",
      type: "AddressUK",
      from: { AddressLine1: "applicantBuildingAndStreet", PostTown: "applicantTownOrCity" }
    });
    expect(spec.composes).toContainEqual({ ccd: "marriageDate", type: "Date", from: { Day: "marriageDay", Month: "marriageMonth", Year: "marriageYear" } });
  });

  it("should keep logic as text with a TODO and list the row when it cannot be parsed", () => {
    const { spec, unparsed, logicRows, parsedRows } = mini();
    const date = spec.sections[1]?.fields[3];
    expect(date?.logicText).toBe("Odd date handling described in prose only");
    expect(date?.todo[0]).toMatch(/^TODO: logic not parsed/);
    expect(unparsed).toEqual([{ row: 8, id: "2.3", keys: ["marriageDay", "marriageMonth", "marriageYear"], reason: expect.any(String) }]);
    expect([logicRows, parsedRows]).toEqual([5, 4]);
  });
});

describe("generateTransformWorkbook", () => {
  it("should differ from the source sheet only in wording, and keep its merged ranges, when the sheet is regenerated", async () => {
    const original = buildMiniD8().worksheets[0];
    if (!original) {
      throw new Error("no sheet");
    }
    const { spec } = mini();
    const diff = diffSheets(original, await reload(generateTransformWorkbook(spec)), 12);
    expect(classify(diff).cells.filter((c) => c.kind === "content")).toEqual([]);
    expect(diff.originalOnlyMerges).toEqual([]);
    expect(diff.regeneratedOnlyMerges).toEqual([]);
  });

  it("should write logic from the rules when the spec holds no text for it", () => {
    const { spec } = mini();
    const field = spec.sections[0]?.fields[0];
    if (!field) {
      throw new Error("expected a field");
    }
    const sheet = generateTransformWorkbook(spec).worksheets[0];
    expect(sheet?.getCell(3, 11).value).toContain("1) If applicationForDivorce = true, divorceOrDissolution = divorce");
    expect(sheet?.getCell(3, 12).value).toBe("1) = success\n\n2) = success\n\n3) = warning\n\nRecord cannot go into exception based on this attribute");
  });

  it("should name the sheet after the form type when it is generated", () => {
    expect(transformSheetName(mini().spec)).toBe("X1 BSS");
  });

  it("should give back the same spec when its own output is imported", async () => {
    const { spec } = mini();
    const again = importTransformSheet(await reload(generateTransformWorkbook(spec)), "X1");
    expect(again.spec).toEqual(spec);
  });
});

describe("transform import", () => {
  const header = [
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
  function sheet(rows: string[][]): ExcelJS.Worksheet {
    const ws = new ExcelJS.Workbook().addWorksheet("T BSS");
    ws.addRow(header);
    for (const r of rows) {
      ws.addRow(r);
    }
    return ws;
  }

  it("should keep keys with underscores and report tokens it rejects when keys are read", () => {
    const result = importTransformSheet(sheet([["1.1", "Name", "text", "Mandatory", "", "", "", "person1_first_name\nbad key!\n----------", "", "", "", ""]]));
    expect(result.spec.sections[0]?.fields[0]?.keys).toEqual(["person1_first_name"]);
    expect(result.rejectedTokens).toEqual([{ row: 2, column: "tagName", token: "bad key!" }]);
  });

  it("should resolve 'Optional/Mandatory if <x>' against the form's keys, and report it when no key fits", () => {
    const resolved = importTransformSheet(
      sheet([
        ["1.1", "Type", "text", "Mandatory", "", "", "", "aJointApplication\naSoleApplication", "", "", "", ""],
        ["1.2", "Other", "text", "Mandatory", "", "", "", "jurisdictionReasonsJointHabitualWho", "", "", "", ""],
        ["1.3", "Sig", "text", "Optional/Mandatory if Joint app", "", "", "", "sig", "", "", "", ""]
      ])
    );
    expect(resolved.spec.sections[0]?.fields[2]?.required).toEqual({ label: "Joint app", when: { aJointApplication: { ticked: true } } });
    expect(resolved.unresolvedConditions).toEqual([]);

    const unresolved = importTransformSheet(sheet([["1.3", "Sig", "text", "Optional/Mandatory if Weird thing", "", "", "", "sig", "", "", "", ""]]));
    const field = unresolved.spec.sections[0]?.fields[0];
    expect(field?.required).toEqual({ label: "Weird thing" });
    expect(field?.todo.join()).toContain("Weird thing");
    expect(unresolved.unresolvedConditions).toEqual([{ row: 2, label: "Weird thing" }]);
  });
});

describe("compose part names", () => {
  const header = [
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
  it("should keep the whole last word of the prefix when the keys already split at a word boundary", () => {
    const ws = new ExcelJS.Workbook().addWorksheet("T BSS");
    ws.addRow(header);
    for (const key of ["soleOrApplicant1SolicitorBuildingAndStreet", "soleOrApplicant1SolicitorTownOrCity", "soleorApplicant1SolicitorFirm"]) {
      ws.addRow(["", key, "text", "Optional", "", "", "", key, "", "applicant1SolicitorAddress", "", ""]);
    }
    const { spec: imported } = importTransformSheet(ws);
    expect(imported.composes[0]?.from).toEqual({
      AddressLine1: "soleOrApplicant1SolicitorBuildingAndStreet",
      PostTown: "soleOrApplicant1SolicitorTownOrCity",
      Firm: "soleorApplicant1SolicitorFirm"
    });
  });
});

describe("conditions resolve to emitted keys only", () => {
  const header = [
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
  it("should not resolve a condition to a key when the key is on a Do-not-read row", () => {
    const ws = new ExcelJS.Workbook().addWorksheet("T BSS");
    ws.addRow(header);
    ws.addRow(["", "heading", "NA", "Do not read", "NA", "", "NA", "jointNote", "", "", "", ""]);
    ws.addRow(["1.2", "Type", "text", "Mandatory", "", "", "", "aJointApplication", "", "", "", ""]);
    ws.addRow(["1.3", "Sig", "text", "Optional/Mandatory if Joint app", "", "", "", "sig", "", "", "", ""]);
    const { spec: imported } = importTransformSheet(ws);
    expect(imported.sections[0]?.fields[2]?.required?.when).toEqual({ aJointApplication: { ticked: true } });
  });
});

describe("importTransformSheet content", () => {
  const rows = [
    [
      "1.1",
      "Married?\n[]Yes\n[]No",
      "XoR (2)",
      "Mandatory",
      "",
      "",
      YES_NO,
      "married\nreason",
      "",
      "marriedCcd",
      "1) If married = Yes, marriedCcd = yes\n\nELSE\n\n2) marriedCcd = no (WITH WARNING)",
      "1) = success\n\n2) = warning\n\nRecord cannot go into exception based on this attribute"
    ],
    [
      "1.2",
      "Signature",
      "text",
      "Optional/Mandatory if Joint app",
      "",
      "",
      '"metadata_field_name": "sig"\n"metadata_field_value": ""',
      "sig",
      "",
      "N/A",
      "Always success",
      "Always success"
    ]
  ];

  it("should model the value list, the mandatory condition, the constant outcome and the notes when a row carries them", () => {
    const { spec } = importTransformSheet(sheetWith(rows));
    const [first, second] = spec.sections[0]?.fields ?? [];
    expect(valueSets(first as never)[0]?.allowed).toEqual(["Yes", "No", "Both"]);
    expect(second).toMatchObject({
      mandatory: "conditional",
      required: { label: "Joint app" },
      casePathNote: "Always success"
    });
    expect(first?.rules[1]).toMatchObject({ note: "(WITH WARNING)", outcome: "warning" });
  });

  it("should report a difference of words as content when the generator cannot reproduce them", async () => {
    expect((await differences(sheetWith(rows))).cells.filter((c) => c.kind === "content")).toEqual([]);

    const typo = sheetWith([["1.1", "Q", "text", "Optional", "", "", '"metadata_field_value": "k"\n"metadata_field_value": ""', "k", "", "N/A", "", ""]]);
    expect((await differences(typo)).cells.filter((c) => c.kind === "content").map((c) => c.address)).toEqual(["G2"]);
  });

  it("should treat case, spacing, dashes, NA and brackets on indices as cosmetic when only they differ, and a changed word as content", () => {
    expect(cosmeticallyEqual("logic", "1)  IF x =yes", "1) If x = yes")).toBe(true);
    expect(cosmeticallyEqual("casePath", "1 Warning", "1) = warning")).toBe(true);
    expect(cosmeticallyEqual("validationRule", "NA", "")).toBe(true);
    expect(cosmeticallyEqual("dataType", "", "text")).toBe(true);
    expect(cosmeticallyEqual("logic", "x = yes", "x = no")).toBe(false);
    expect(cosmeticallyEqual("logic", "1) If x = yes, y = no", "1) y = no")).toBe(false);
    expect(cosmeticallyEqual("logic", "1) If x = yes, y = no", "1) x = yes, y = no")).toBe(true);
    expect(cosmeticallyEqual("casePath", "Success\n\nRecord cannot go", "Record cannot go\n\nSuccess")).toBe(true);
  });
});

describe("blank rows and case path notes", () => {
  const rows = [
    ["1.1", "Name", "text", "Optional", "", "", '"metadata_field_name": "a"\n"metadata_field_value": ""', "a", "", "", "", ""],
    ["", "", "", "", "", "", "", "", "", "", "", ""],
    ["1.2", "Other", "text", "Optional", "", "", '"metadata_field_name": "b"\n"metadata_field_value": ""', "b", "", "", "", ""]
  ];

  it("should keep a spacer row so every later row stays aligned when the sheet has one", async () => {
    const original = sheetWith(rows);
    const { spec } = importTransformSheet(original);
    expect(spec.sections[0]?.fields.map((f) => f.role)).toEqual(["field", "blank", "field"]);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await generateTransformWorkbook(spec).xlsx.writeBuffer()) as ArrayBuffer);
    expect(book.worksheets[0]?.getCell(4, 1).value).toBe("1.2");
    expect((await differences(original)).cells.filter((c) => c.kind === "content")).toEqual([]);
  });

  it("should keep a case path note when the row's logic is only partly parsed", () => {
    const partial = sheetWith([
      [
        "1.1",
        "Q",
        "text",
        "Optional",
        "",
        "",
        '"metadata_field_name": "a"\n"metadata_field_value": ""',
        "a",
        "",
        "",
        "1) If a = x, do something odd, success\n\nELSE\n\n2) warning",
        "1) = success\n\n2) = warning\n\nNOTE: check the address"
      ]
    ]);
    const field = importTransformSheet(partial).spec.sections[0]?.fields[0];
    expect(field?.todo.length).toBeGreaterThan(0);
    expect(field?.casePathNote).toBe("NOTE: check the address");
  });
});

describe("composes need evidence, and merged cells never lose text", () => {
  const row = (id: string, key: string, ccd: string, logic: string) => [
    id,
    key,
    "text",
    "Optional",
    "",
    "",
    `"metadata_field_name": "${key}"\n"metadata_field_value": ""`,
    key,
    "",
    ccd,
    logic,
    "Success"
  ];

  it("should not treat rows as one compose when they merely share a CCD field", () => {
    const { spec } = imp6(
      sw6([
        row("1.2", "aSoleApplication", "applicationType", "applicationType = soleApplication"),
        row("", "aJointApplication", "applicationType", "applicationType = jointApplication")
      ])
    );
    expect(spec.composes).toEqual([]);
  });

  it("should treat rows as a compose when the sheet merged their CCD cell", () => {
    const sheet = sw6([row("2.3", "homeBuildingAndStreet", "homeAddress", "Populate these"), row("", "homeTownOrCity", "homeAddress", "Populate these")]);
    sheet.mergeCells("J2:J3");
    expect(imp6(sheet).spec.composes[0]).toMatchObject({ ccd: "homeAddress", from: { AddressLine1: "homeBuildingAndStreet", PostTown: "homeTownOrCity" } });
  });

  it("should treat address parts as a compose when there is no merge", () => {
    const { spec } = imp6(
      sw6([row("2.3", "homeBuildingAndStreet", "homeAddress", "x"), row("", "homeTownOrCity", "homeAddress", "x"), row("", "homePostcode", "homeAddress", "x")])
    );
    expect(spec.composes).toHaveLength(1);
  });

  it("should not merge a column when its text differs between the rows of a compose", () => {
    const spec = fss6.parse({
      form: { formType: "T", name: "T" },
      sections: [
        {
          id: "1",
          title: "",
          fields: [fs6.parse({ keys: ["a"], ccd: ["c"], logicText: "first" }), fs6.parse({ keys: ["b"], ccd: ["c"], logicText: "second" })]
        }
      ],
      composes: [{ ccd: "c", from: { A: "a", B: "b" } }]
    });
    const merges = gen6(spec).worksheets[0]?.model.merges ?? [];
    expect(merges).toContain("J2:J3");
    expect(merges).not.toContain("K2:K3");
  });
});

describe("conditions resolve to a ticked test", () => {
  it("should read 'Optional/Mandatory if Joint app' as the key being ticked when the condition names a key, not equal to 'true'", () => {
    const header = TH6;
    expect(header.length).toBe(12);
    const sheet = sw6([
      ["1.1", "Type", "text", "Mandatory", "", "", "", "aJointApplication", "", "", "", ""],
      ["1.3", "Sig", "text", "Optional/Mandatory if Joint app", "", "", "", "sig", "", "", "", ""]
    ]);
    expect(imp6(sheet).spec.sections[0]?.fields[1]?.required).toEqual({ label: "Joint app", when: { aJointApplication: { ticked: true } } });
  });
});

describe("CCD cell", () => {
  it("should take the id of an 'id: value' line as a CCD id and keep the line as a note", () => {
    const { spec } = importTransformSheet(
      sheetWith([
        [
          "1.1",
          "Q",
          "text",
          "Optional",
          "",
          "",
          "",
          "a",
          "",
          "applicant1Name\nOther Payment:\npaperCasePaymentMethod: phone\npaperCasePaymentMethod: cheque/postal order",
          "",
          ""
        ]
      ])
    );
    const field = spec.sections[0]?.fields[0];
    expect(field?.ccd).toEqual(["applicant1Name", "paperCasePaymentMethod"]);
    expect(field?.ccdNote).toBe("Other Payment:\npaperCasePaymentMethod: phone\npaperCasePaymentMethod: cheque/postal order");
  });
});
