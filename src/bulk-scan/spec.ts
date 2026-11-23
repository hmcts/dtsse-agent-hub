import {
  type CcdField,
  type CcdRow,
  caseDataFor,
  ccdFieldsOf,
  type Data,
  expectedFor,
  type FormSpec,
  formSpecSchema,
  fromPdf,
  generateSipWorkbook,
  generateTarget,
  generateTransformWorkbook,
  importSip,
  importTransformSheet,
  isModelKey,
  modelByKey,
  readsKeys,
  readWorkbookBytes,
  type Scenario,
  SIP,
  scenarios,
  selectSheet,
  TARGETS,
  type Target,
  validData
} from "@hmcts-cft/bulk-scan-spec";
import { z } from "zod";
import { HttpError } from "../agent-api/http.ts";
import { CCD_FIELD_ROWS } from "../assistant/ccd-jobs.ts";
import { isPdf } from "../assistant/docmosis.ts";
import { isXlsx } from "../assistant/welsh.ts";
import { zipFiles } from "./zip.ts";

/**
 * The Bulk Scan page's engine: everything it does with a form spec beyond storing it. The spec package does the work and
 * this runs it in the hub's own process, because import, edit, simulate and download need nothing but the uploaded file
 * and the saved spec: no person's credentials, so no job in their pod. Pure, and `spec-store.ts` is the Postgres half.
 */

/** A saved spec's JSON: the D8 form, 91 field rows, is under 400 KiB. */
export const MAX_SPEC_BYTES = 3 * 1024 * 1024;
export const MAX_SPEC_NAME = 200;

/** The case type a person picked, whose fields their pod fetched: the product that defines it and how it configures CCD. */
export interface PickedCaseType {
  caseType: string;
  product: string;
  config?: "config-generator" | "json" | "hybrid";
  fields: CcdField[];
}

/** The case fields a pod job found, as the browser sends them back with an upload. */
export function parseCcdFields(json: unknown): CcdField[] {
  const parsed = CCD_FIELD_ROWS.safeParse(json);
  if (!parsed.success) {
    throw new HttpError(400, "the case type's fields are not in the shape the CCD job answers");
  }
  return ccdFieldsOf(parsed.data as CcdRow[]);
}

export interface Imported {
  kind: "pdf" | "sip" | "transformation sheet";
  forms: FormSpec[];
}

/**
 * Reads an uploaded form PDF, Exela SIP or HMCTS transformation sheet into one spec per form it holds, with `caseType`
 * as each form's CCD case type id. A PDF's fields are matched against `picked`, the case type the person chose.
 */
export async function importUpload(fileName: string, bytes: Uint8Array, caseType?: string, picked?: PickedCaseType): Promise<Imported> {
  if (isPdf(bytes)) {
    const result = await fromPdf({ pdf: fileName, bytes, ...(picked ? { ccdFields: picked.fields } : {}), ...(caseType ? { caseType } : {}) }).catch(
      (error: unknown) => {
        console.error(`a form PDF could not be read: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        return undefined;
      }
    );
    if (!result) {
      throw new HttpError(400, "that PDF could not be read");
    }
    if (result.needsReview) {
      throw new HttpError(422, `${result.needsReview.reason}, so no field could be read from it. Ask your assistant to read its pages and draft the spec`);
    }
    const forms = picked
      ? result.bundle.forms.map((spec) => ({
          ...spec,
          form: { ...spec.form, ccdProduct: picked.product, ...(picked.config ? { ccdConfig: picked.config } : {}) }
        }))
      : result.bundle.forms;
    return { kind: "pdf", forms };
  }
  if (!isXlsx(bytes)) {
    throw new HttpError(400, "choose a form PDF, an Exela SIP or a transformation sheet (.xlsx)");
  }
  const workbook = await readWorkbookBytes(bytes).catch(() => undefined);
  if (!workbook) {
    throw new HttpError(400, "that spreadsheet could not be read");
  }
  if (workbook.worksheets.some((s) => SIP.formSheetPattern.test(s.name))) {
    const forms = readSheet(() => importSip(workbook).forms);
    if (forms.length === 0) {
      throw new HttpError(422, "that SIP has no filled-in form tab");
    }
    return openable({ kind: "sip", forms: withCaseType(forms, caseType) });
  }
  const { spec } = readSheet(() => importTransformSheet(selectSheet(workbook, undefined)));
  if (spec.sections.every((s) => s.fields.length === 0)) {
    throw new HttpError(422, "no field rows were found in the first sheet: is it a transformation sheet?");
  }
  return openable({ kind: "transformation sheet", forms: withCaseType([spec], caseType) });
}

/** The forms with the CCD case type the person typed as their header's, when one was typed. */
function withCaseType(forms: FormSpec[], caseType: string | undefined): FormSpec[] {
  return caseType ? forms.map((f) => ({ ...f, form: { ...f.form, ccdCaseTypeId: caseType } })) : forms;
}

/** An importer's refusal of a sheet that is not laid out as it expects, as the 422 that says where. */
function readSheet<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof z.ZodError || (error instanceof Error && error.name === "ZodError")) {
      const issues = (error as z.ZodError).issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`);
      throw new HttpError(422, `that spreadsheet is not laid out as expected (${issues.join("; ")})`);
    }
    throw new HttpError(422, error instanceof Error ? error.message : "that spreadsheet could not be read");
  }
}

/** An upload is kept only if the editor can open it, so a key or regex the engine cannot use is refused here, with the field. */
function openable(imported: Imported): Imported {
  for (const spec of imported.forms) {
    const checked = checkSpec(spec);
    if (!checked.ok) {
      const shown = checked.issues.slice(0, 3).map((i) => `${i.path || "form"}: ${i.message}`);
      throw new HttpError(422, `${specName(spec, "that form")} cannot be used as it stands (${shown.join("; ")})`);
    }
  }
  return imported;
}

/** What a spec is called in the list: the form's name, else its form type. */
export function specName(spec: FormSpec, fallback: string): string {
  const name = (spec.form.name || spec.form.formType || fallback).trim();
  return [...name].slice(0, MAX_SPEC_NAME).join("") || "Untitled form";
}

export interface SpecIssue {
  /** Where in the spec, as the editor addresses it: `sections.2.fields.5.keys.0`. */
  path: string;
  message: string;
}

/** A spec as the schema and the engine accept it, or every reason one of them does not. */
export function checkSpec(raw: unknown): { ok: true; spec: FormSpec } | { ok: false; issues: SpecIssue[] } {
  const parsed = formSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
  }
  const regexIssues = parsed.data.sections.flatMap((section, s) =>
    section.fields.flatMap((field, f) => {
      try {
        if (field.regex) {
          new RegExp(field.regex);
        }
        return [];
      } catch (error) {
        return [
          {
            path: `sections.${s}.fields.${f}.regex`,
            message: `not a regular expression Node can run: ${error instanceof Error ? error.message : String(error)}`
          }
        ];
      }
    })
  );
  if (regexIssues.length > 0) {
    return { ok: false, issues: regexIssues };
  }
  const lengthIssues = parsed.data.sections.flatMap((section, s) =>
    section.fields.flatMap((field, f) =>
      field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength
        ? [{ path: `sections.${s}.fields.${f}.minLength`, message: `the minimum length ${field.minLength} is above the maximum ${field.maxLength}` }]
        : []
    )
  );
  if (lengthIssues.length > 0) {
    return { ok: false, issues: lengthIssues };
  }
  const keyIssues = keyShapeIssues(parsed.data);
  if (keyIssues.length > 0) {
    return { ok: false, issues: keyIssues };
  }
  try {
    modelByKey(parsed.data);
  } catch (error) {
    return { ok: false, issues: [{ path: "sections", message: error instanceof Error ? error.message : String(error) }] };
  }
  return { ok: true, spec: parsed.data };
}

/** A key the generated code names as an identifier must be a word; a new row's empty key is refused on its own row. */
function keyShapeIssues(spec: FormSpec): SpecIssue[] {
  return spec.sections.flatMap((section, s) =>
    section.fields.flatMap((field, f) =>
      readsKeys(field)
        ? field.keys.flatMap((key, k) =>
            isModelKey(key)
              ? []
              : [{ path: `sections.${s}.fields.${f}.keys.${k}`, message: `the key "${key}" must be letters, digits and underscores, starting with a letter` }]
          )
        : []
    )
  );
}

export type ScenarioEntry = Pick<Scenario, "name" | "kind" | "description">;

/** The generated sample submissions, named and described; each one's data is read by name when it is picked. */
export function scenarioEntries(spec: FormSpec): ScenarioEntry[] {
  return scenarios(spec).map(({ name, kind, description }) => ({ name, kind, description }));
}

/** The keys a sample envelope can carry, which are the keys the spec reads. */
export function envelopeKeys(spec: FormSpec): string[] {
  return [...modelByKey(spec).keys()];
}

const dataSchema = z.record(z.string(), z.string().max(5000));

export interface Simulation {
  data: Data;
  expected: Scenario["expected"];
  /** The CCD fields the spec itself decides, which is none when the envelope ends as an exception record. */
  caseData: ReturnType<typeof caseDataFor>;
}

/** Runs one envelope through the spec: a generated scenario by name, or the key/value pairs the person edited. */
export function simulate(spec: FormSpec, input: { scenario?: unknown; data?: unknown }): Simulation {
  let data: Data;
  if (typeof input.scenario === "string") {
    const found = scenarios(spec).find((s) => s.name === input.scenario);
    if (!found) {
      throw new HttpError(404, "that scenario no longer exists: it depends on the spec's version");
    }
    data = found.data;
  } else if (input.data === undefined) {
    data = validData(spec);
  } else {
    const parsed = dataSchema.safeParse(input.data);
    if (!parsed.success) {
      throw new HttpError(400, "an envelope is key and value pairs of text");
    }
    data = parsed.data;
  }
  const expected = expectedFor(spec, data);
  return { data, expected, caseData: expected.transformation === "exception-record" ? {} : caseDataFor(spec, data) };
}

export const JAVA_PACKAGE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
export const DEFAULT_JAVA_PACKAGE = "com.example.bulkscan";

export function isTarget(value: unknown): value is Target {
  return typeof value === "string" && (TARGETS as readonly string[]).includes(value);
}

export interface Download {
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function stem(spec: FormSpec): string {
  return (spec.form.formType || spec.form.name || "form").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "form";
}

/** The Exela SIP, built on a blank in the shape of the V3.2 template: the supplier's own file is not held here. */
export async function sipDownload(spec: FormSpec): Promise<Download> {
  const book = generateSipWorkbook({ forms: [spec] });
  return { fileName: `${stem(spec)}-sip.xlsx`, contentType: XLSX, bytes: new Uint8Array((await book.xlsx.writeBuffer()) as ArrayBuffer) };
}

export async function transformDownload(spec: FormSpec): Promise<Download> {
  const book = generateTransformWorkbook(spec);
  return { fileName: `${stem(spec)}-transformation.xlsx`, contentType: XLSX, bytes: new Uint8Array((await book.xlsx.writeBuffer()) as ArrayBuffer) };
}

/** What one codegen target writes for the form, zipped. A form without a usable form type is refused with the engine's own words. */
export function codeDownload(spec: FormSpec, target: Target, javaPackage: string): Download {
  if (!JAVA_PACKAGE.test(javaPackage)) {
    throw new HttpError(400, "the Java package is lower-case words joined by dots, such as uk.gov.hmcts.divorce.bulkscan");
  }
  try {
    const files = generateTarget(target, spec, { basePackage: javaPackage });
    return {
      fileName: `${stem(spec)}-${target}.zip`,
      contentType: "application/zip",
      bytes: zipFiles(files.map((f) => ({ path: f.path, content: f.content })))
    };
  } catch (error) {
    throw new HttpError(422, error instanceof Error ? error.message : "the code could not be generated");
  }
}

/** An uploaded file's name as shown back (as the browser gave it, not URL-encoded): the last path part, safe characters only, ending `.pdf` or `.xlsx`. */
export function uploadFileName(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const base = (raw.split(/[\\/]/).pop() ?? "")
    .replace(/[^\p{L}\p{N} ._()-]/gu, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return /\.(pdf|xlsx)$/i.test(base) ? base : null;
}

/** The `version` a request names: a whole number from 1, or absent for the latest. */
export function versionOf(raw: unknown): number | undefined {
  const n = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}
