import {
  buildBlankTemplate,
  type FormSpec,
  formSpecSchema,
  generateSipWorkbook,
  generateTransformWorkbook,
  readWorkbookBytes
} from "@hmcts-cft/bulk-scan-spec";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HttpError } from "../agent-api/http.ts";
import { addField, addRule, mapField, mapRule, withAssignments, withGroups } from "./edit.ts";
import {
  checkSpec,
  codeDownload,
  envelopeKeys,
  importUpload,
  isTarget,
  parseCcdFields,
  scenarioEntries,
  simulate,
  sipDownload,
  specName,
  transformDownload,
  uploadFileName,
  versionOf
} from "./spec.ts";

const pdf = vi.hoisted(() => ({ result: undefined as unknown, input: undefined as unknown }));
const sip = vi.hoisted(() => ({ fail: false }));
vi.mock("@hmcts-cft/bulk-scan-spec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hmcts-cft/bulk-scan-spec")>();
  return {
    ...actual,
    importSip: (workbook: unknown) => {
      if (sip.fail) {
        z.object({ forms: z.array(z.object({ sections: z.array(z.object({ fields: z.array(z.object({ inputType: z.enum(["text"]) })) })) })) }).parse({
          forms: [{ sections: [{ fields: [{ inputType: "bad" }] }] }]
        });
      }
      return actual.importSip(workbook as never);
    },
    fromPdf: async (input: unknown) => {
      pdf.input = input;
      if (pdf.result === undefined) {
        throw new Error("unreadable");
      }
      return pdf.result;
    }
  };
});

const SPEC: FormSpec = formSpecSchema.parse({
  form: { name: "T1", formType: "T1" },
  sections: [
    {
      id: "1",
      title: "About",
      fields: [
        { id: "1.1", label: "First name", keys: ["firstName"], mandatory: "mandatory", ccd: ["applicantFirstName"] },
        { id: "1.2", label: "Email", keys: ["email"], regex: "^[a-z]+@x\\.com$" },
        {
          id: "1.3",
          label: "Kind",
          keys: ["divorce", "dissolution"],
          inputType: "checkbox",
          mandatory: "mandatory",
          group: { kind: "xor", size: 2, options: [{ key: "divorce" }, { key: "dissolution" }] },
          emits: [
            { key: "divorce", value: "true" },
            { key: "divorce", value: "false" },
            { key: "dissolution", value: "true" },
            { key: "dissolution", value: "false" }
          ],
          ccd: ["kind"],
          rules: [
            { ref: "1", when: { divorce: true }, set: { kind: "divorce" }, outcome: "success" },
            { ref: "2", otherwise: true, outcome: "warning" }
          ]
        }
      ]
    }
  ]
});

async function bytesOf(book: Awaited<ReturnType<typeof readWorkbookBytes>>): Promise<Uint8Array> {
  return new Uint8Array((await book.xlsx.writeBuffer()) as ArrayBuffer);
}

const refusal = async (work: Promise<unknown>) =>
  (await work.then(
    () => undefined,
    (e: unknown) => e
  )) as HttpError;

describe("uploads", () => {
  it("should read a transformation sheet into one spec", async () => {
    const imported = await importUpload("t.xlsx", await bytesOf(generateTransformWorkbook(SPEC)));
    expect(imported.kind).toBe("transformation sheet");
    expect(imported.forms).toHaveLength(1);
  });

  it("should read an Exela SIP into the specs of its form tabs", async () => {
    const imported = await importUpload("sip.xlsx", await bytesOf(generateSipWorkbook({ forms: [SPEC] })));
    expect(imported.kind).toBe("sip");
    expect(imported.forms.map((f) => f.form.formType)).toEqual(["T1"]);
  });

  it("should refuse a SIP with no filled-in form tab", async () => {
    const error = await refusal(importUpload("sip.xlsx", await bytesOf(buildBlankTemplate())));
    expect(error.status).toBe(422);
  });

  it("should refuse a sheet with no field rows", async () => {
    const empty = generateTransformWorkbook({ ...SPEC, sections: [] });
    expect((await refusal(importUpload("x.xlsx", await bytesOf(empty)))).status).toBe(422);
  });

  it("should refuse a file that is neither a PDF nor a spreadsheet", async () => {
    expect((await refusal(importUpload("x.xlsx", new TextEncoder().encode("hello")))).status).toBe(400);
  });

  it("should refuse a zip that is not a workbook when it names a workbook's entries but cannot be read", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode("[Content_Types].xml xl/")]);
    expect((await refusal(importUpload("x.xlsx", bytes))).message).toContain("could not be read");
  });

  it("should take the forms a PDF's draft holds", async () => {
    pdf.result = { bundle: { forms: [SPEC] }, checklist: [] };
    expect((await importUpload("f.pdf", new TextEncoder().encode("%PDF-1.7"))).forms).toEqual([SPEC]);
  });

  it("should name the case type the person typed in a PDF's form header", async () => {
    pdf.result = { bundle: { forms: [SPEC] }, checklist: [] };
    await importUpload("f.pdf", new TextEncoder().encode("%PDF-1.7"), "CIC");
    expect(pdf.input).toMatchObject({ caseType: "CIC" });
    expect(pdf.input).not.toHaveProperty("ccdFields");
  });

  it("should match against the fields the person's pod fetched, and record the product and how it configures CCD", async () => {
    pdf.result = { bundle: { forms: [SPEC] }, checklist: [] };
    const fields = parseCcdFields([{ ID: "cicCaseFullName", Label: "Full name", FieldType: "Text" }]);

    const { forms } = await importUpload("f.pdf", new TextEncoder().encode("%PDF-1.7"), "CriminalInjuriesCompensation", {
      caseType: "CriminalInjuriesCompensation",
      product: "sptribs",
      config: "config-generator",
      fields
    });

    expect(pdf.input).toMatchObject({ ccdFields: [{ id: "cicCaseFullName", label: "Full name", type: "Text" }], caseType: "CriminalInjuriesCompensation" });
    expect(forms[0]?.form).toMatchObject({ ccdProduct: "sptribs", ccdConfig: "config-generator" });
  });

  it("should refuse fields that are not what the CCD job answers", () => {
    expect(() => parseCcdFields([{ ID: "a" }])).toThrow("not in the shape");
    expect(() => parseCcdFields("x")).toThrow("not in the shape");
  });

  it("should match a spreadsheet's rows against the case type picked, keeping the ids the sheet has, and record the product and configuration", async () => {
    const fields = parseCcdFields([{ ID: "applicantFirstName", Label: "First name", FieldType: "Text" }]);
    const picked = { caseType: "NFD", product: "nfdiv", config: "config-generator" as const, fields };

    const imported = await importUpload("t.xlsx", await bytesOf(generateTransformWorkbook(SPEC)), "NFD", picked);

    const [form] = imported.forms;
    expect(form?.form).toMatchObject({ ccdCaseTypeId: "NFD", ccdProduct: "nfdiv", ccdConfig: "config-generator" });
    expect(form?.sections[0]?.fields[0]).toMatchObject({ ccd: ["applicantFirstName"], ccdMatch: { status: "existing" } });
    expect(form?.sections[0]?.fields[1]?.ccdMatch).toBeDefined();
  });

  it("should set the case type on a spreadsheet's forms when one is typed", async () => {
    const imported = await importUpload("t.xlsx", await bytesOf(generateTransformWorkbook(SPEC)), "CIC");
    expect(imported.forms.map((f) => f.form.ccdCaseTypeId)).toEqual(["CIC"]);
    const sip = await importUpload("sip.xlsx", await bytesOf(generateSipWorkbook({ forms: [SPEC] })), "CIC");
    expect(sip.forms.map((f) => f.form.ccdCaseTypeId)).toEqual(["CIC"]);
  });

  it("should refuse a PDF with no form fields, saying why", async () => {
    pdf.result = { bundle: { forms: [] }, checklist: [], needsReview: { reason: "the PDF has no AcroForm fields", promptText: "" } };
    const error = await refusal(importUpload("f.pdf", new TextEncoder().encode("%PDF-1.7")));
    expect([error.status, error.message]).toEqual([422, expect.stringContaining("no AcroForm fields")]);
  });

  it("should refuse a PDF that cannot be read", async () => {
    pdf.result = undefined;
    expect((await refusal(importUpload("f.pdf", new TextEncoder().encode("%PDF-1.7")))).status).toBe(400);
  });
});

describe("file and spec names", () => {
  it("should keep the last path part with safe characters, for a pdf or xlsx only", () => {
    expect(uploadFileName("C:\\docs\\My form (1).PDF")).toBe("My form (1).PDF");
    expect(uploadFileName("a<b.xlsx")).toBe("a_b.xlsx");
    expect(uploadFileName("Fee 100% form.pdf")).toBe("Fee 100_ form.pdf");
    expect(uploadFileName("notes.txt")).toBeNull();
    expect(uploadFileName(undefined)).toBeNull();
  });

  it("should name a spec after its form, else its type, else the file", () => {
    expect(specName(SPEC, "file")).toBe("T1");
    expect(specName({ ...SPEC, form: { ...SPEC.form, name: "", formType: "X" } }, "file")).toBe("X");
    expect(specName({ ...SPEC, form: { ...SPEC.form, name: "", formType: "" } }, "file")).toBe("file");
    expect(specName({ ...SPEC, form: { ...SPEC.form, name: "", formType: "" } }, "")).toBe("Untitled form");
  });
});

describe("checking a spec", () => {
  it("should accept a valid spec with its defaults filled in", () => {
    expect(checkSpec(JSON.parse(JSON.stringify(SPEC)))).toEqual({ ok: true, spec: SPEC });
  });

  it("should name the field and member when the schema refuses it", () => {
    const bad = JSON.parse(JSON.stringify(SPEC));
    bad.sections[0].fields[2].keys = ["divorce"];
    const checked = checkSpec(bad);
    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.issues.map((i) => i.path)).toEqual(["sections.0.fields.2"]);
  });

  it("should refuse a minimum length above the maximum, on the field's own row", () => {
    const bad = JSON.parse(JSON.stringify(SPEC));
    bad.sections[0].fields[0].minLength = 9;
    bad.sections[0].fields[0].maxLength = 3;
    const checked = checkSpec(bad);
    expect(!checked.ok && checked.issues).toEqual([{ path: "sections.0.fields.0.minLength", message: "the minimum length 9 is above the maximum 3" }]);
  });

  it("should refuse a key the engine cannot use", () => {
    const bad = JSON.parse(JSON.stringify(SPEC));
    bad.sections[0].fields[0].keys = ["first name"];
    const checked = checkSpec(bad);
    expect(!checked.ok && checked.issues[0]?.message).toContain("first name");
  });
});

describe("checking what editing can break", () => {
  const edited = (change: (spec: FormSpec) => FormSpec) => checkSpec(JSON.parse(JSON.stringify(change(SPEC))));
  const withRule = (rule: object) => (spec: FormSpec) => mapField(spec, 0, 1, (f) => ({ ...f, rules: [rule as never] }));

  it("should flag the empty key on its own row when a new field has no key yet", () => {
    const checked = edited((spec) => addField(spec, 0));
    expect(!checked.ok && checked.issues.map((i) => i.path)).toEqual(["sections.0.fields.3.keys.0"]);
  });

  it("should accept a rule when it names a key the form does not read, since the generated code leaves it as a TODO", () => {
    expect(edited(withRule({ when: { nope: "x" }, set: { applicantFirstName: { from: "nope" } } })).ok).toBe(true);
  });

  it("should accept a condition when it names a key of the form, a sheet id or a value the row writes", () => {
    for (const when of [{ firstName: null }, { "1.1": "x" }, { "ccd:kind": "divorce" }]) {
      expect(edited(withRule({ when, outcome: "warning" })).ok).toBe(true);
    }
  });
});

describe("what the simulator offers", () => {
  it("should list the scenarios and the keys of the envelope", () => {
    expect(scenarioEntries(SPEC).map((s) => s.name)).toContain("valid");
    expect(envelopeKeys(SPEC)).toEqual(["firstName", "email", "divorce", "dissolution"]);
  });
});

describe("simulating", () => {
  it("should give the valid sample a success and the CCD fields it sets", () => {
    const result = simulate(SPEC, { scenario: "valid" });
    expect(result.expected.validation).toBe("success");
    expect(result.caseData).toMatchObject({ kind: "divorce", applicantFirstName: expect.any(String) });
  });

  it("should warn of a blank mandatory key, and run the values it is given", () => {
    const valid = simulate(SPEC, {}).data;
    const result = simulate(SPEC, { data: { ...valid, firstName: "" } });
    expect(result.expected.validation).toBe("warning");
    expect(result.expected.basis.join("\n")).toContain("firstName");
  });

  it("should give no case data when the envelope becomes an exception record", () => {
    const exception = formSpecSchema.parse({
      form: { name: "E", formType: "E" },
      sections: [
        { id: "1", title: "", fields: [{ id: "1", keys: ["k"], ccd: ["c"], rules: [{ ref: "1", otherwise: true, set: { c: "x" }, outcome: "exception" }] }] }
      ]
    });
    expect(simulate(exception, { data: { k: "v" } })).toMatchObject({ expected: { transformation: "exception-record" }, caseData: {} });
  });

  it("should change an envelope's outcome and case data when a rule is added in the editor", () => {
    const data = simulate(SPEC, {}).data;
    expect(simulate(SPEC, { data }).expected.transformation).not.toBe("exception-record");

    const raised = mapField(SPEC, 0, 1, (f) =>
      mapRule(addRule(f), 0, (r) => ({ ...withGroups(r, [[{ key: "email", op: "filled", value: "" }]]), outcome: "exception" as const }))
    );
    expect(simulate(raised, { data }).expected.transformation).toBe("exception-record");
    expect(simulate(raised, { data: { ...data, email: "" } }).expected.transformation).not.toBe("exception-record");

    const copied = mapField(SPEC, 0, 1, (f) => ({
      ...f,
      ccd: ["applicantEmail"],
      rules: [withAssignments({}, [{ target: "applicantEmail", copy: true, value: "email" }])]
    }));
    expect(simulate(copied, { data: { ...data, email: "a@x.com" } }).caseData).toMatchObject({ applicantEmail: "a@x.com" });
  });

  it("should refuse a scenario the version does not have, and values that are not text", () => {
    expect(() => simulate(SPEC, { scenario: "nope" })).toThrow(HttpError);
    expect(() => simulate(SPEC, { data: { a: 1 } })).toThrow(HttpError);
  });
});

describe("downloads", () => {
  it("should build the SIP and the transformation sheet as workbooks named after the form", async () => {
    const sip = await sipDownload(SPEC);
    const transform = await transformDownload(SPEC);
    expect([sip.fileName, transform.fileName]).toEqual(["T1-sip.xlsx", "T1-transformation.xlsx"]);
    for (const file of [sip, transform]) {
      expect((await readWorkbookBytes(file.bytes)).worksheets.length).toBeGreaterThan(0);
    }
  });

  it("should zip the code of a target", () => {
    const file = codeDownload(SPEC, "fis", "com.example.bulkscan");
    expect(file.fileName).toBe("T1-fis.zip");
    expect(file.contentType).toBe("application/zip");
    expect([...file.bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it("should refuse a Java package that is not lower-case words, and a form type that cannot name a file", () => {
    expect(() => codeDownload(SPEC, "nfdiv", "Bad Package")).toThrow(HttpError);
    expect(() => codeDownload({ ...SPEC, form: { ...SPEC.form, formType: "" } }, "fis", "a.b")).toThrow(HttpError);
  });

  it("should name a form without a type or a name 'form'", async () => {
    expect((await transformDownload({ ...SPEC, form: { ...SPEC.form, name: "", formType: "" } })).fileName).toBe("form-transformation.xlsx");
  });

  it("should know the targets", () => {
    expect([isTarget("nfdiv"), isTarget("x"), isTarget(undefined)]).toEqual([true, false, false]);
  });
});

describe("version in a request", () => {
  it("should read a whole number from 1 and nothing else", () => {
    expect([versionOf("3"), versionOf(2), versionOf("0"), versionOf("1.5"), versionOf("x"), versionOf(null), versionOf(undefined)]).toEqual([
      3,
      2,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    ]);
  });
});

describe("a regex the engine cannot compile", () => {
  const withRegex = (regex: string) => {
    const copy = JSON.parse(JSON.stringify(SPEC));
    copy.sections[0].fields[1].regex = regex;
    return copy;
  };

  it.each(["[a-", "(?i)abc"])("should be refused on its row when the regex is %s", (regex) => {
    const checked = checkSpec(withRegex(regex));
    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.issues.map((i) => i.path)).toEqual(["sections.0.fields.1.regex"]);
  });
});

describe("an upload whose spec the editor could not open", () => {
  it("should be refused with what is wrong when a key is not a word", async () => {
    const bad = JSON.parse(JSON.stringify(SPEC));
    bad.sections[0].fields[0].keys = ["applicant-name"];
    const error = await refusal(importUpload("sip.xlsx", await bytesOf(generateSipWorkbook({ forms: [bad] }))));
    expect([error.status, error.message]).toEqual([422, expect.stringContaining("applicant-name")]);
  });

  it("should be refused with a readable message when the importer's own schema rejects the sheet", async () => {
    sip.fail = true;
    const error = await refusal(importUpload("sip.xlsx", await bytesOf(generateSipWorkbook({ forms: [SPEC] }))));
    sip.fail = false;
    expect([error.status, error.message]).toEqual([422, expect.stringContaining("forms.0.sections.0.fields.0.inputType")]);
  });
});
