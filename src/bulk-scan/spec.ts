import {
  allFields,
  caseDataFor,
  type Data,
  expectedFor,
  type Field,
  type FormSpec,
  formSpecSchema,
  fromPdf,
  generateSipWorkbook,
  generateTarget,
  generateTransformWorkbook,
  importSip,
  importTransformSheet,
  modelByKey,
  readWorkbookBytes,
  renderCasePath,
  renderLogic,
  type Scenario,
  SIP,
  scenarios,
  selectSheet,
  TARGETS,
  type Target,
  validData,
  valueSets
} from "@hmcts-cft/bulk-scan-spec";
import { z } from "zod";
import { HttpError } from "../agent-api/http.ts";
import { zipFiles } from "./zip.ts";

/**
 * The Bulk Scan page's engine: everything it does with a form spec beyond storing it. The spec package does the work and
 * this runs it in the hub's own process, because import, edit, simulate and download need nothing but the uploaded file
 * and the saved spec: no person's credentials, so no job in their pod. Pure, and `spec-store.ts` is the Postgres half.
 */

export const MAX_BULK_SCAN_FILE_BYTES = 5 * 1024 * 1024;
/** A saved spec's JSON: the D8 form, 91 field rows, is under 400 KiB. */
export const MAX_SPEC_BYTES = 3 * 1024 * 1024;
export const MAX_SPEC_NAME = 200;

/** `%PDF`, and an `.xlsx` is a zip, which starts `PK\x03\x04`. Neither proves the content is readable, but both refuse a typo. */
function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((byte, i) => bytes[i] === byte);
}

export interface Imported {
  kind: "pdf" | "sip" | "transformation sheet";
  forms: FormSpec[];
}

/** Reads an uploaded form PDF, Exela SIP or HMCTS transformation sheet into one spec per form it holds. */
export async function importUpload(fileName: string, bytes: Uint8Array): Promise<Imported> {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) {
    const result = await fromPdf({ pdf: fileName, bytes }).catch((error: unknown) => {
      console.error(`a form PDF could not be read: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      return undefined;
    });
    if (!result) {
      throw new HttpError(400, "that PDF could not be read");
    }
    if (result.needsReview) {
      throw new HttpError(422, `${result.needsReview.reason}, so no field could be read from it. Ask your assistant to read its pages and draft the spec`);
    }
    return { kind: "pdf", forms: result.bundle.forms };
  }
  if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    throw new HttpError(400, "choose a form PDF, an Exela SIP or a transformation sheet (.xlsx)");
  }
  const workbook = await readWorkbookBytes(bytes).catch(() => undefined);
  if (!workbook) {
    throw new HttpError(400, "that spreadsheet could not be read");
  }
  if (workbook.worksheets.some((s) => SIP.formSheetPattern.test(s.name))) {
    const forms = importSip(workbook).forms;
    if (forms.length === 0) {
      throw new HttpError(422, "that SIP has no filled-in form tab");
    }
    return { kind: "sip", forms };
  }
  const { spec } = importTransformSheet(selectSheet(workbook, undefined));
  if (spec.sections.every((s) => s.fields.length === 0)) {
    throw new HttpError(422, "no field rows were found in the first sheet: is it a transformation sheet?");
  }
  return { kind: "transformation sheet", forms: [spec] };
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
  try {
    modelByKey(parsed.data);
  } catch (error) {
    return { ok: false, issues: [{ path: "sections", message: error instanceof Error ? error.message : String(error) }] };
  }
  return { ok: true, spec: parsed.data };
}

/** What the editor shows of a field and cannot edit: its rules as the transformation sheet words them, and its allowed values. */
export interface FieldNotes {
  rules: string;
  casePath: string;
  allowed: string[];
}

export function fieldNotes(field: Field): FieldNotes {
  return {
    rules: (field.rules.length > 0 || field.logicPreamble ? renderLogic(field.rules, field.logicPreamble) : field.logicText) ?? "",
    casePath: [renderCasePath(field.rules, field.neverExceeds), field.casePathNote].filter(Boolean).join("\n\n"),
    allowed: valueSets(field).map((s) => `${s.key}: ${[...s.allowed, ...(s.blankAllowed ? ["(blank)"] : [])].join(" | ")}`)
  };
}

/** Each field's notes, in the order of `allFields`, which is the order of the editor's rows. */
export function allNotes(spec: FormSpec): FieldNotes[] {
  return allFields(spec).map(fieldNotes);
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

/** An uploaded file's name as shown back: the last path part, safe characters only, ending `.pdf` or `.xlsx`. */
export function uploadFileName(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const base = (name.split(/[\\/]/).pop() ?? "")
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
