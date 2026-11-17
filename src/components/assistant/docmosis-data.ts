/**
 * The template panel's rules, pure: the shapes the hub serves (`DocmosisView`), the data paths the form edits, the date
 * formats a Docmosis template parses, and the checks that decide whether a value is certain to be rejected. The form
 * and the panel are the screen; this is what they agree on.
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type PathSegment = string | number;

export interface ScalarSchema {
  kind: "string" | "boolean" | "date";
  controls: string[];
  notes: string[];
  inputFormat?: string;
}
export interface ObjectSchema {
  kind: "object";
  controls: string[];
  notes: string[];
  properties: Record<string, DocmosisField>;
}
export interface ArraySchema {
  kind: "array";
  controls: string[];
  notes: string[];
  item: ObjectSchema;
}
export type DocmosisField = ScalarSchema | ObjectSchema | ArraySchema;
export interface DocmosisSchema {
  root: ObjectSchema;
  warnings: string[];
}

export interface RenderError {
  short: string;
  long: string;
}

/** One version of the conversation's template, as `GET /api/ui/assistant/docmosis/{id}` serves it. */
export interface DocmosisView {
  version: number;
  revision: number;
  name: string;
  docx: string;
  schema: DocmosisSchema;
  data: JsonObject;
  by: "agent" | "user";
  summary: string | null;
  updated_at: string;
  has_pdf: boolean;
  render_error: RenderError | null;
  current_version?: number;
}

/** What the page carries of the latest version, which the panel reads the rest of when it changes. */
export interface DocmosisSummary {
  name: string;
  version: number;
  revision: number;
  updatedBy: "agent" | "user";
  /** Whether the latest version's PDF is still being put after it, is there, or could not be made. */
  pdf: "pending" | "ready" | "failed";
}

export interface DocmosisVersionEntry {
  version: number;
  by: "agent" | "user";
  summary: string | null;
  updated_at: string;
  has_pdf: boolean;
}

export function docmosisUrl(conversationId: string): string {
  return `/api/ui/assistant/docmosis/${encodeURIComponent(conversationId)}`;
}
export const docmosisVersionsUrl = (conversationId: string): string => `${docmosisUrl(conversationId)}/versions`;
export const docmosisVersionUrl = (conversationId: string, version: number): string => `${docmosisUrl(conversationId)}/versions/${version}`;
export const docmosisPdfUrl = (conversationId: string, version: number): string => `${docmosisVersionUrl(conversationId, version)}/pdf`;
export const docmosisRenderUrl = (conversationId: string): string => `${docmosisUrl(conversationId)}/render`;

export const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

export function getAt(data: Json | undefined, path: readonly PathSegment[]): Json | undefined {
  let current: Json | undefined = data;
  for (const segment of path) {
    if (typeof segment === "number") {
      current = Array.isArray(current) ? current[segment] : undefined;
    } else {
      current = isObject(current) ? current[segment] : undefined;
    }
  }
  return current;
}

/**
 * A copy of `data` with `path` set to `value`. An undefined value removes the key, and objects left empty by the
 * removal go too, so the data holds only what was supplied.
 */
export function setAt(data: JsonObject, path: readonly PathSegment[], value: Json | undefined): JsonObject {
  const [head, ...rest] = path;
  if (head === undefined) {
    return data;
  }
  const result = setIn(data, head, rest, value);
  return isObject(result) ? result : {};
}

function setIn(node: Json | undefined, head: PathSegment, rest: PathSegment[], value: Json | undefined): Json | undefined {
  if (typeof head === "number") {
    const array = Array.isArray(node) ? [...node] : [];
    for (let i = array.length; i < head; i++) {
      array[i] = {};
    }
    const next = rest.length === 0 ? value : setIn(array[head], rest[0] as PathSegment, rest.slice(1), value);
    array[head] = next === undefined ? {} : next;
    return array;
  }
  const object: JsonObject = isObject(node) ? { ...node } : {};
  const next = rest.length === 0 ? value : setIn(object[head], rest[0] as PathSegment, rest.slice(1), value);
  if (next === undefined || (isObject(next) && Object.keys(next).length === 0 && rest.length > 0)) {
    delete object[head];
  } else {
    object[head] = next;
  }
  return object;
}

export function sameData(a: Json | undefined, b: Json | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const TOKEN = /yyyy|yy|MM|M|dd|d/g;
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/** True when a format uses only year, month and day tokens, so a native date input can represent it. */
export function isDateOnlyFormat(format: string): boolean {
  if (/M{3,}|d{3,}|(?<!y)y{3}(?!y)|y{5,}/.test(format)) {
    return false;
  }
  const rest = format.replace(TOKEN, "");
  return /^[^A-Za-z']*$/.test(rest) && /yyyy|yy/.test(format) && /M/.test(format) && /d/.test(format);
}

interface Parts {
  year: number;
  month: number;
  day: number;
}

export function formatDate({ year, month, day }: Parts, format: string): string {
  return format.replace(TOKEN, (token) => {
    switch (token) {
      case "yyyy":
        return pad(year, 4);
      case "yy":
        return pad(year % 100, 2);
      case "MM":
        return pad(month, 2);
      case "M":
        return String(month);
      case "dd":
        return pad(day, 2);
      default:
        return String(day);
    }
  });
}

/** Parses a value written in `format`, or returns undefined when it does not match or is not a real day. */
export function parseDate(value: string, format: string): Parts | undefined {
  const order: string[] = [];
  let pattern = "";
  let last = 0;
  for (const found of format.matchAll(TOKEN)) {
    pattern += escapeRegex(format.slice(last, found.index));
    last = found.index + found[0].length;
    order.push(found[0]);
    pattern += found[0] === "yyyy" ? "(\\d{4})" : found[0] === "yy" ? "(\\d{2})" : found[0].length === 2 ? "(\\d{2})" : "(\\d{1,2})";
  }
  pattern += escapeRegex(format.slice(last));
  const match = new RegExp(`^${pattern}$`).exec(value.trim());
  if (!match) {
    return undefined;
  }
  const parts: Partial<Parts> = {};
  order.forEach((token, i) => {
    const n = Number(match[i + 1]);
    if (token.startsWith("y")) {
      parts.year = token === "yy" ? 2000 + n : n;
    } else if (token.startsWith("M")) {
      parts.month = n;
    } else {
      parts.day = n;
    }
  });
  if (parts.year === undefined || parts.month === undefined || parts.day === undefined) {
    return undefined;
  }
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const real = date.getUTCFullYear() === parts.year && date.getUTCMonth() === parts.month - 1 && date.getUTCDate() === parts.day;
  return real ? (parts as Parts) : undefined;
}

/** The stored value (in the template's input format) as the yyyy-MM-dd a date input shows. */
export function storedToInput(stored: string, format: string): string {
  const parts = parseDate(stored, format);
  return parts ? formatDate(parts, "yyyy-MM-dd") : "";
}

/** A date input's yyyy-MM-dd as the value stored in the data, in the template's input format. */
export function inputToStored(input: string, format: string): string {
  const parts = parseDate(input, "yyyy-MM-dd");
  return parts ? formatDate(parts, format) : "";
}

/**
 * Whether `value` has the shape `format` describes, or undefined when the format cannot be checked (time tokens,
 * quoted text or tokens outside d, M and y). Docmosis parses leniently, so only the structure is checked.
 */
export function matchesDateFormat(value: string, format: string): boolean | undefined {
  const tokens = /d{1,2}|M{1,4}|y{4}|y{2}/g;
  const literals = format.replace(tokens, "");
  if (/[A-Za-z']/.test(literals) || !/d/.test(format) || !/M/.test(format) || !/y/.test(format)) {
    return undefined;
  }
  let pattern = "";
  let last = 0;
  for (const found of format.matchAll(tokens)) {
    pattern += escapeRegex(format.slice(last, found.index));
    last = found.index + found[0].length;
    pattern += found[0].startsWith("M") && found[0].length >= 3 ? "[\\p{L}.]+" : "\\d+";
  }
  pattern += escapeRegex(format.slice(last));
  return new RegExp(`^${pattern}$`, "u").test(value.trim());
}

export interface FieldIssue {
  path: PathSegment[];
  message: string;
}

/** A stable key for a data path, used to look up the problem with the value it names. */
export const pathKey = (path: readonly PathSegment[]): string => JSON.stringify(path);

/** The problem with one value, or undefined when it is fine or cannot be checked with certainty. */
export function validateValue(schema: DocmosisField, value: unknown): string | undefined {
  if (schema.kind !== "date" || value === undefined || value === null || value === "") {
    return undefined;
  }
  const format = schema.inputFormat;
  if (!format) {
    return undefined;
  }
  if (typeof value !== "string") {
    return `Expected a date written as ${format}.`;
  }
  return matchesDateFormat(value, format) === false ? `"${value}" isn't a date written as ${format}.` : undefined;
}

/** Every value in `data` that Docmosis is certain to reject. Empty values are fine: they render blank. */
export function validateData(schema: ObjectSchema, data: JsonObject): FieldIssue[] {
  const issues: FieldIssue[] = [];
  collect(schema, data, [], issues);
  return issues;
}

function collect(schema: ObjectSchema, data: JsonObject, prefix: PathSegment[], issues: FieldIssue[]): void {
  for (const [key, child] of Object.entries(schema.properties)) {
    const path = [...prefix, key];
    if (child.kind === "object") {
      collect(child, data, path, issues);
    } else if (child.kind === "array") {
      const rows = getAt(data, path);
      if (Array.isArray(rows)) {
        rows.forEach((row, index) => {
          if (isObject(row)) {
            collect(child.item, data, [...path, index], issues);
          }
        });
      }
    } else {
      const message = validateValue(child, getAt(data, path));
      if (message) {
        issues.push({ path, message });
      }
    }
  }
}
