import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { spec } from "./__fixtures__/helpers.ts";
import { valueSets } from "./emits.ts";
import type { Bundle, FormSpec } from "./schema.ts";
import {
  bundleSchema,
  fieldSchema,
  formSpecSchema,
  fieldSchema as fSchema,
  fieldSchema as fSchema9,
  fieldSchema as fs8,
  formSpecSchema as fsSchema,
  formSpecSchema as fsSchema9,
  formSpecSchema as fss8,
  formSpecSchema as fssZ,
  fieldSchema as fsZ
} from "./schema.ts";
import { generateSipWorkbook, generateSipWorkbook as genSip, sipRows } from "./sip-generate.ts";
import { importSip, importSip as impR8b, importSip as impSip } from "./sip-import.ts";
import { buildBlankTemplate as blank, buildBlankTemplate as blankR8, buildBlankTemplate } from "./sip-template.ts";
import { generateTransformWorkbook } from "./transform-generate.ts";
import { importTransformSheet } from "./transform-import.ts";

function form(name: string, count = 3): FormSpec {
  return formSpecSchema.parse({
    form: { name, formType: name, documentType: "Form", poBox: "PO Box 1", supplier: "Exela", serviceName: "Divorce", description: "Apply", volumes: "100" },
    sections: [
      {
        id: "1",
        title: "S",
        fields: [
          fieldSchema.parse({
            id: "1.1",
            label: "What application?\n[]Divorce\n[]Dissolution",
            inputType: "checkbox",
            mandatory: "mandatory",
            keys: ["applicationForDivorce", "applicationForDissolution"],
            group: {
              kind: "xor",
              size: 2,
              options: [
                { key: "applicationForDivorce", label: "Divorce" },
                { key: "applicationForDissolution", label: "Dissolution" }
              ]
            },
            businessRules: "default to divorce",
            validationRule: "warn when empty"
          }),
          ...Array.from({ length: count }, (_, i) =>
            fieldSchema.parse({
              label: `Name ${i}`,
              keys: [`name${i}`],
              maxLength: 35,
              handwriting: "handwritten",
              regex: "^[A-Z]+$",
              defaultValue: "x",
              sip: { tagName: "t" }
            })
          ),
          fieldSchema.parse({ role: "label", label: "Not read", mandatory: "not-read", inputType: "none" })
        ]
      }
    ],
    pageOrder: [
      { page: 1, keys: ["applicationForDivorce", "name0"] },
      { page: 2, keys: ["name1"] }
    ],
    expectedDocuments: [{ order: 1, name: "D8 form", identifier: "QR code", requirements: "scan all", notes: "n" }]
  });
}

async function reload(workbook: ExcelJS.Workbook): Promise<ExcelJS.Workbook> {
  const out = new ExcelJS.Workbook();
  await out.xlsx.load((await workbook.xlsx.writeBuffer()) as ArrayBuffer);
  return out;
}

describe("sipRows values", () => {
  it("should list the values the description emits for a key whose case differs from the description's", () => {
    const s = spec([
      {
        id: "4.1",
        keys: ["MarriageOutsideOfUK"],
        emits: [
          { key: "marriageOutsideOfUK", value: "Yes" },
          { key: "marriageOutsideOfUK", value: "No" },
          { key: "marriageOutsideOfUK", value: "Both" }
        ]
      }
    ]);
    expect(sipRows(s).map((r) => r.value)).toEqual(["Yes|No|Both"]);
  });
});

describe("sipRows", () => {
  it("should write one row per key and repeat the id across a group when rows are generated, and skip fields that are not read", () => {
    const rows = sipRows(form("D8"));
    expect(rows.map((r) => [r.id, r.key, r.inputType, r.value])).toEqual([
      ["1.1", "applicationForDivorce", "Check box", "true|false"],
      ["1.1", "applicationForDissolution", "Check box", "true|false"],
      ["", "name0", "Text box", ""],
      ["", "name1", "Text box", ""],
      ["", "name2", "Text box", ""]
    ]);
    expect(rows[0]?.name).toBe("Divorce");
    expect(rows[2]).toMatchObject({ maxLength: "35", handwriting: "Handwritten", regex: "^[A-Z]+$", defaultValue: "x", tagName: "t" });
  });
});

describe("generateSipWorkbook", () => {
  it("should fill the header block, field table, page order and expected documents when a template is given", async () => {
    const out = await reload(
      generateSipWorkbook({ overview: { serviceName: "Divorce", completedBy: "Me", contacts: [{ name: "Ann", email: "a@x" }] }, forms: [form("D8")] })
    );
    const sheet = out.getWorksheet("Form 1");
    expect(sheet?.getCell("B6").value).toBe("Divorce");
    expect(sheet?.getCell("B7").value).toBe("PO Box 1");
    expect(sheet?.getCell("B9").value).toBe("D8");
    expect(sheet?.getCell("B10").value).toBe("D8");
    expect(sheet?.getCell("B16").value).toBe("100");
    expect(sheet?.getCell("B18").value).toBe("Apply");
    expect(sheet?.getCell("M4").value).toBe("Me");
    expect(sheet?.getCell("D28").value).toBe("applicationForDivorce");
    expect(sheet?.getCell("I28").value).toBeNull();
    expect(sheet?.getCell("I30").value).toBe(35);
    expect(sheet?.getCell("B115").value).toBe(1);
    expect(sheet?.getCell("F115").value).toBe("D8 form");
    expect(sheet?.getCell("I115").value).toBe("QR code");
    expect(sheet?.getCell("A27").value).toBe("ID");
    const pages = out.getWorksheet("Page order");
    expect([pages?.getCell("B3").value, pages?.getCell("C3").value, pages?.getCell("D3").value]).toEqual(["Page 1", "applicationForDivorce", 1]);
    expect([pages?.getCell("B5").value, pages?.getCell("C5").value, pages?.getCell("D5").value]).toEqual(["Page 2", "name1", 1]);
    const overview = out.getWorksheet("Overview");
    expect([overview?.getCell("C4").value, overview?.getCell("C5").value, overview?.getCell("D8").value, overview?.getCell("D10").value]).toEqual([
      "Divorce",
      "Me",
      "Ann",
      "a@x"
    ]);
  });

  it("should keep the template's merges and its labels when the workbook is generated", async () => {
    const template = buildBlankTemplate();
    const before = new Set(template.getWorksheet("Form 1")?.model.merges);
    const out = await reload(generateSipWorkbook({ forms: [form("D8")] }, template));
    const merges = out.getWorksheet("Form 1")?.model.merges ?? [];
    expect(new Set(merges)).toEqual(before);
    expect(out.getWorksheet("Form 1")?.getCell("A114").value).toMatch(/^Expected Documents/);
  });

  it("should move the expected-documents table down when there are more rows than the table has room for", async () => {
    const out = await reload(generateSipWorkbook({ forms: [form("D8", 100)] }));
    const sheet = out.getWorksheet("Form 1");
    const rows = 102;
    const tableRow = 114 + (rows - 86);
    expect(sheet?.getCell(28 + rows - 1, 4).value).toBe("name99");
    expect(sheet?.getCell(tableRow, 1).value).toMatch(/^Expected Documents/);
    expect(sheet?.getCell(114, 1).value).toBeNull();
    expect(sheet?.getCell(tableRow + 1, 6).value).toBe("D8 form");
    expect(sheet?.model.merges).toContain(`A${tableRow}:A${tableRow + 5}`);
    expect(importSip(out).forms[0]?.expectedDocuments).toHaveLength(1);
  });

  it("should add one tab per extra form when the bundle has several, in order and laid out like the first", async () => {
    const out = await reload(generateSipWorkbook({ forms: [form("D8"), form("D84", 1)] }));
    expect(out.worksheets.map((s) => s.name)).toEqual(["Overview", "Ramp up volumes", "Cherished", "Exceptions", "Form 1", "Form 2", "Page order"]);
    const second = out.getWorksheet("Form 2");
    expect(second?.getCell("B9").value).toBe("D84");
    expect(second?.getCell("A27").value).toBe("ID");
    expect(new Set(second?.model.merges)).toEqual(new Set(out.getWorksheet("Form 1")?.model.merges));
    expect(out.getWorksheet("Ramp up volumes")?.getCell("A4").value).toBe("D84");
  });

  it("should drop the field-name dropdowns when they point at the missing Standard Fields workbook", () => {
    const template = buildBlankTemplate();
    const sheet = template.getWorksheet("Form 1");
    if (!sheet) {
      throw new Error("no sheet");
    }
    sheet.getCell("B43").dataValidation = { type: "list", formulae: ["StdFields"] };
    sheet.getCell("B44").dataValidation = { type: "whole", operator: "between", formulae: [1, 9] };
    const out = generateSipWorkbook({ forms: [form("D8")] }, template);
    const model = (out.getWorksheet("Form 1") as unknown as { dataValidations: { model: Record<string, unknown> } }).dataValidations.model;
    expect(Object.keys(model)).toEqual(["B44"]);
  });

  it("should fail clearly when the template has no Form tab", () => {
    const empty = new ExcelJS.Workbook();
    empty.addWorksheet("Overview");
    expect(() => generateSipWorkbook({ forms: [form("D8")] }, empty)).toThrow(/no 'Form n' sheet/);
  });
});

describe("importSip", () => {
  it("should read back the keys, group, requirements and form details when a generated SIP is imported", async () => {
    const original = form("D8");
    const out = await reload(generateSipWorkbook({ overview: { serviceName: "Divorce", contacts: [] }, forms: [original] }));
    const bundle: Bundle = bundleSchema.parse(importSip(out));
    const [back] = bundle.forms;
    expect(back?.form).toMatchObject({ name: "D8", formType: "D8", poBox: "PO Box 1", supplier: "Exela", serviceName: "Divorce", volumes: "100" });
    expect(back && sipRows(back)).toEqual(sipRows(original));
    expect(back?.sections[0]?.fields[0]).toMatchObject({ id: "1.1", keys: ["applicationForDivorce", "applicationForDissolution"], mandatory: "mandatory" });
    expect(back?.pageOrder).toEqual(original.pageOrder);
    expect(back?.expectedDocuments).toEqual(original.expectedDocuments);
  });

  it("should return no forms when the template is unfilled, and ignore its example page-order rows", () => {
    const template = buildBlankTemplate();
    template.getWorksheet("Page order")?.addRow(["Example", "Page 1 ", "extraCopiesOfGrant", 1]);
    expect(importSip(template).forms).toEqual([]);
  });
});

describe("SIP page order", () => {
  it("should not multiply page-order rows when several forms are written, read and written again", async () => {
    const forms = ["T1", "T2"].map((name, i) => {
      const f = spec([{ keys: [`key${i}`, "shared"] }], name);
      f.pageOrder = [{ page: 1, keys: [`key${i}`, "shared"] }];
      return f;
    });
    let book = generateSipWorkbook({ forms });
    for (let round = 0; round < 3; round++) {
      const buffer = (await book.xlsx.writeBuffer()) as ArrayBuffer;
      const read = new ExcelJS.Workbook();
      await read.xlsx.load(buffer);
      const bundle = importSip(read);
      book = generateSipWorkbook(bundle);
    }
    const rows: string[] = [];
    book.getWorksheet("Page order")?.eachRow((row, n) => {
      if (n >= 3 && row.getCell(3).value) {
        rows.push(String(row.getCell(3).value));
      }
    });
    expect(rows.sort((a, b) => (a < b ? -1 : 1))).toEqual(["key0", "key1", "shared"]);
  });
});

describe("SIP value column", () => {
  it("should round-trip a tick box's full value set when the sheet allows a blank, through the SIP", async () => {
    const f = formSpecSchema.parse({
      form: { name: "T", formType: "T" },
      sections: [
        {
          id: "1",
          title: "",
          fields: [
            fieldSchema.parse({ keys: ["tick"], inputType: "checkbox" }),
            fieldSchema.parse({
              keys: ["married", "reason"],
              inputType: "checkbox",
              emits: [
                { key: "married", value: "Yes" },
                { key: "married", value: "No" },
                { key: "married", value: "" },
                { key: "reason", value: "" }
              ]
            })
          ]
        }
      ]
    });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await generateSipWorkbook({ forms: [f] }).xlsx.writeBuffer()) as ArrayBuffer);
    const back = importSip(book).forms[0];
    const fields = back?.sections[0]?.fields ?? [];
    expect(fields.flatMap((x) => valueSets(x))).toEqual([
      { key: "tick", allowed: ["true", "false"], blankAllowed: false },
      { key: "married", allowed: ["Yes", "No"], blankAllowed: true, blankMeans: undefined },
      { key: "reason", allowed: [], blankAllowed: true, blankMeans: undefined }
    ]);
  });
});

async function roundTripped(bundle: Parameters<typeof genSip>[0], template?: ExcelJS.Workbook): Promise<ExcelJS.Workbook> {
  const out = new ExcelJS.Workbook();
  await out.xlsx.load((await genSip(bundle, template).xlsx.writeBuffer()) as ArrayBuffer);
  return out;
}

describe("SIP grouping, regeneration and clones", () => {
  it("should read an id-less field with several keys back as one field when it is imported", async () => {
    const f = fsSchema.parse({
      form: { name: "T", formType: "T" },
      sections: [
        { id: "1", title: "", fields: [fSchema.parse({ keys: ["dateDay", "dateMonth", "dateYear"], inputType: "date" }), fSchema.parse({ keys: ["solo"] })] }
      ]
    });
    const back = impSip(await roundTripped({ forms: [f] })).forms[0];
    expect(back?.sections[0]?.fields.map((x) => [x.id, x.keys])).toEqual([
      [undefined, ["dateDay", "dateMonth", "dateYear"]],
      [undefined, ["solo"]]
    ]);
  });

  it("should grow the Expected Documents table below the fields when there are more documents and fields than the template has rows", async () => {
    const f = fsSchema.parse({
      form: { name: "T", formType: "T" },
      sections: [{ id: "1", title: "", fields: Array.from({ length: 100 }, (_, i) => fSchema.parse({ keys: [`k${i}`] })) }],
      expectedDocuments: Array.from({ length: 8 }, (_, i) => ({ order: i + 1, name: `Doc ${i + 1}` }))
    });
    const back = impSip(await roundTripped({ forms: [f] })).forms[0];
    expect(back?.expectedDocuments).toHaveLength(8);
    expect(back?.sections[0]?.fields).toHaveLength(100);
  });

  it("should refuse a generated SIP as the template when its Expected Documents table has moved", async () => {
    const big = fsSchema.parse({
      form: { name: "T", formType: "T" },
      sections: [{ id: "1", title: "", fields: Array.from({ length: 100 }, (_, i) => fSchema.parse({ keys: [`k${i}`] })) }]
    });
    const first = await roundTripped({ forms: [big] });
    expect(() => genSip({ forms: [big] }, first)).toThrow(/Expected Documents table/);
  });

  it("should give Form 2 the template's data validations when it is cloned, except the Standard Fields ones", async () => {
    const template = blank();
    const sheet = template.getWorksheet("Form 1");
    if (!sheet) {
      throw new Error("no sheet");
    }
    sheet.getCell("F30").dataValidation = { type: "list", formulae: ['"Text box,Check box,Date"'] };
    sheet.getCell("B43").dataValidation = { type: "list", formulae: ["StdFields"] };
    const out = await roundTripped({ forms: [fsSchema.parse({ form: { name: "A" } }), fsSchema.parse({ form: { name: "B" } })] }, template);
    for (const name of ["Form 1", "Form 2"]) {
      const model = (out.getWorksheet(name) as unknown as { dataValidations: { model: Record<string, { formulae?: string[] }> } }).dataValidations.model;
      expect(Object.keys(model), name).toEqual(["F30"]);
      expect(model.F30?.formulae?.[0], name).toBe('"Text box,Check box,Date"');
    }
  });
});

describe("SIP regeneration over a filled workbook", () => {
  it("should clear every contact block when the new spec has fewer contacts than the template holds", async () => {
    const big = fsSchema9.parse({ form: { name: "A", formType: "A" } });
    const contacts = [0, 1, 2, 3].map((i) => ({ name: `N${i}`, telephone: `T${i}`, email: `E${i}`, role: `R${i}` }));
    const first = await roundTripped({ overview: { serviceName: "S", contacts }, forms: [big] });
    const second = await roundTripped({ overview: { serviceName: "S", contacts: [contacts[0] as (typeof contacts)[number]] }, forms: [big] }, first);
    const overview = second.getWorksheet("Overview");
    expect(overview?.getCell("D8").value).toBe("N0");
    for (const cell of ["D12", "D13", "D16", "D19", "D23"]) {
      expect(overview?.getCell(cell).value, cell).toBeNull();
    }
  });

  it("should refuse a template that has more form tabs than the spec has forms", async () => {
    const mk = (i: number) => fsSchema9.parse({ form: { name: `F${i}`, formType: "A" } });
    const first = await roundTripped({ forms: [mk(0), mk(1)] });
    expect(() => genSip({ forms: [mk(0)] }, first)).toThrow(/form tabs/);
  });

  it("should leave the template's Example rows alone when the Page order sheet is filled", async () => {
    const template = buildBlankTemplate();
    const pages = template.getWorksheet("Page order");
    pages?.addRow(["Example", "Page 1 ", "extraCopies", 1]);
    pages?.addRow(["Example", "Page 1 ", "otherCopies", 2]);
    const f = fsSchema9.parse({ form: { name: "A", formType: "A" }, pageOrder: [{ page: 1, keys: ["k1", "k2"] }] });
    const out = await roundTripped({ forms: [f] }, template);
    const rows: string[][] = [];
    out.getWorksheet("Page order")?.eachRow((row, n) => {
      if (n >= 3) {
        rows.push([String(row.getCell(1).value ?? ""), String(row.getCell(3).value ?? "")]);
      }
    });
    expect(rows).toEqual([
      ["Example", "extraCopies"],
      ["Example", "otherCopies"],
      ["", "k1"],
      ["", "k2"]
    ]);
    expect(importSip(out).forms[0]?.pageOrder).toEqual([{ page: 1, keys: ["k1", "k2"] }]);
  });

  it("should keep two consecutive fields apart when they have the same sheet id", async () => {
    const f = fsSchema9.parse({
      form: { name: "A", formType: "A" },
      sections: [
        {
          id: "1",
          title: "",
          fields: [
            fSchema9.parse({ id: "2.1", keys: ["a1", "a2"] }),
            fSchema9.parse({ id: "2.1", keys: ["b1", "b2"] }),
            fSchema9.parse({ id: "2.1", keys: ["c"] })
          ]
        }
      ]
    });
    const back = importSip(await roundTripped({ forms: [f] })).forms[0];
    expect(back?.sections[0]?.fields.map((x) => [x.id, x.keys])).toEqual([
      ["2.1", ["a1", "a2"]],
      ["2.1", ["b1", "b2"]],
      ["2.1", ["c"]]
    ]);
  });
});

describe("SIP ramp-up sheet", () => {
  it("should name a row per form and leave the template's placeholders below them when the ramp-up sheet is filled", async () => {
    const mk = (i: number) => fss8.parse({ form: { name: `F${i}`, formType: "A" } });
    const out = (await roundTripped({ forms: [mk(0), mk(1)] })).getWorksheet("Ramp up volumes");
    expect(out?.getCell("A3").value).toBe("F0");
    expect(out?.getCell("A4").value).toBe("F1");
    expect(out?.getCell("A5").value).toBe("Form 3");
    expect(fs8.parse({}).role).toBe("field");
  });
});

describe("SIP cloning and dates", () => {
  it("should clone a Form tab and fill both forms when the bundle has two forms with more fields than the template has rows", async () => {
    const big = (name: string) =>
      fssZ.parse({
        form: { name, formType: name },
        sections: [{ id: "1", title: "", fields: Array.from({ length: 100 }, (_, i) => fsZ.parse({ keys: [`k${i}`] })) }],
        expectedDocuments: [{ order: 1, name: "Doc" }]
      });
    const forms = importSip(await roundTripped({ forms: [big("A"), big("B")] })).forms;
    expect(forms.map((f) => f.form.name)).toEqual(["A", "B"]);
    expect(forms.map((f) => f.expectedDocuments.length)).toEqual([1, 1]);
    expect(forms.map((f) => f.sections[0]?.fields.length)).toEqual([100, 100]);
  });

  it("should round-trip a sign-off date as a date with its number format when the overview is generated", async () => {
    const template = buildBlankTemplate();
    const overview = template.getWorksheet("Overview");
    const cell = overview?.getCell("C7");
    if (cell) {
      cell.value = new Date(Date.UTC(2026, 2, 4));
      cell.numFmt = "dd/mm/yyyy";
    }
    const bundle = importSip(template);
    expect(bundle.overview?.signOffDate).toBe("2026-03-04");
    const out = await roundTripped({ forms: [fssZ.parse({ form: { name: "A", formType: "A" } })], overview: bundle.overview }, template);
    const written = out.getWorksheet("Overview")?.getCell("C7");
    expect(written?.value).toEqual(new Date(Date.UTC(2026, 2, 4)));
    expect(written?.numFmt).toBe("dd/mm/yyyy");
  });
});

describe("SIP import with a blank key row", () => {
  it("should leave a blank-key row out of the group's options when the SIP has one, as well as out of its keys", () => {
    const template = blankR8();
    const sheet = template.getWorksheet("Form 1");
    const rows = [
      ["2.1", "Yes", "Question", "optA", "true", "Check box", "", "Mandatory"],
      ["2.1", "No", "Question", "", "", "Check box", "", "Mandatory"],
      ["2.1", "Maybe", "Question", "optB", "true", "Check box", "", "Mandatory"]
    ];
    for (const [i, values] of rows.entries()) {
      for (const [c, v] of values.entries()) {
        const cell = sheet?.getCell(28 + i, c + 1);
        if (cell) {
          cell.value = v || null;
        }
      }
    }
    const field = impR8b(template).forms[0]?.sections[0]?.fields[0];
    expect(field?.keys).toEqual(["optA", "optB"]);
    expect(field?.group).toMatchObject({ size: 2, options: [{ key: "optA" }, { key: "optB" }] });
  });
});

describe("regenerating into a SIP that already has several form tabs", () => {
  it("should place a new tab after the last existing form tab when the template has two", async () => {
    const first = await reload(generateSipWorkbook({ forms: [form("D8"), form("D84", 1)] }));
    const out = await reload(generateSipWorkbook({ forms: [form("D8"), form("D84", 1), form("D85", 2), form("D86", 3)] }, first));
    expect(out.worksheets.map((s) => s.name).filter((n) => /^Form \d+$/.test(n))).toEqual(["Form 1", "Form 2", "Form 3", "Form 4"]);
    expect(out.worksheets.at(-1)?.name).toBe("Page order");
  });
});

describe("a SIP row with a key and no Mandatory value", () => {
  it("should come back with the same role when it goes through a transformation sheet", async () => {
    const { buildBlankTemplate } = await import("./sip-template.ts");
    const { importSip } = await import("./sip-import.ts");
    const template = buildBlankTemplate();
    const sheet = template.getWorksheet("Form 1");
    const values = ["2.1", "Unread", "Text", "unreadKey", "", "Text", "", ""];
    values.forEach((v, c) => {
      const cell = sheet?.getCell(28, c + 1);
      if (cell) {
        cell.value = v || null;
      }
    });
    const imported = importSip(template).forms[0];
    const field = imported?.sections.flatMap((x) => x.fields).find((f) => f.keys.includes("unreadKey"));
    expect(field?.mandatory).toBe("not-read");
    const out = generateTransformWorkbook(imported as never).worksheets[0];
    const back = importTransformSheet(out as never)
      .spec.sections.flatMap((x) => x.fields)
      .find((f) => f.keys.includes("unreadKey"));
    expect(back?.role).toBe(field?.role);
  });
});
