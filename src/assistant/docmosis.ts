import { z } from "zod";
import { boundedArray } from "../agent-api/bounded-array.ts";
import { jsonbText } from "./deck.ts";

/**
 * A conversation's Docmosis template as the hub keeps it: the .docx, the form schema `docmosis schema` extracted from
 * it (dtsse-docmosis-tools' `inferSchema`), the data the form holds and the PDF rendered from them. The .docx is named
 * by the SHA-256 of bytes the hub holds, as a deck's pictures are. See "Docmosis templates" in docs/agent-api.md.
 */

/** One .docx and one PDF: the migration's CHECKs. */
export const MAX_DOCX_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_BYTES = 5 * 1024 * 1024;
/** The migration's CHECKs on `schema` and `data`: the bytes of the jsonb's text, as Postgres prints it. */
export const MAX_SCHEMA_BYTES = 120_000;
export const MAX_DATA_BYTES = 120_000;
export const MAX_DOCMOSIS_NAME = 200;
export const MAX_SUMMARY = 200;
/** How many versions are kept, and how many of the newest keep their PDF. */
export const KEEP_VERSIONS = 50;
export const KEEP_PDF = 10;

/**
 * Refused for a conversation whose pod runs a client older than `items`, which reads and writes only the primary
 * template: a second one would be a template its session never sees, and a load for it would replace the primary.
 */
export const ITEMS_CREATE_REFUSED_DOCMOSIS = "your assistant needs an update to hold more than one Docmosis template; it gets one the next time it restarts";
/** Object levels in a schema, the root being the first; an array's item is one more. */
export const MAX_SCHEMA_DEPTH = 20;
export const MAX_PROPERTIES = 500;
/** Every .docx a conversation holds, those only older versions name included. */
export const MAX_HELD_DOCX_BYTES = 64 * 1024 * 1024;
/** How long a .docx no kept version names is kept, so one can be uploaded before the version that names it. */
export const ASSET_GRACE_MS = 60 * 60 * 1000;
/** Nesting of the data. A form's data follows the schema, so this is far beyond what one needs; it stops a recursion. */
export const MAX_DATA_DEPTH = 64;
/** A merge error's two texts, clipped to these before they are stored. */
export const MAX_ERROR_SHORT = 500;
export const MAX_ERROR_LONG = 8000;

const MAX_PROPERTY_NAME = 200;
const MAX_LIST = 200;
const MAX_TEXT = 2000;
const MAX_WARNINGS = 500;

export type DocmosisAuthor = "agent" | "user";

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

const texts = (max: number, length: number) => boundedArray(z.string().max(length), max, { message: `at most ${max} entries` });

const common = { controls: texts(MAX_LIST, MAX_PROPERTY_NAME), notes: texts(MAX_LIST, MAX_TEXT) };

const scalar = z.strictObject({ kind: z.enum(["string", "boolean", "date"]), ...common, inputFormat: z.string().max(MAX_PROPERTY_NAME).optional() });

const propertyName = z.string().min(1).max(MAX_PROPERTY_NAME);

/**
 * An object field `level` levels down. The levels are built one inside the next, so the cap on depth is in the shape
 * itself: the last level takes scalars only, and an input nested further is refused where it first goes too deep,
 * with no recursion over it.
 */
function objectField(level: number): z.ZodType<ObjectSchema> {
  // Built once: an object and an array's item are the same level below, so building it for each would double the work at every level.
  const below = level >= MAX_SCHEMA_DEPTH ? undefined : objectField(level + 1);
  const field = below === undefined ? scalar : z.union([scalar, below, z.strictObject({ kind: z.literal("array"), ...common, item: below })]);
  return z.strictObject({
    kind: z.literal("object"),
    ...common,
    properties: z
      .record(propertyName, field)
      .refine((properties) => Object.keys(properties).length <= MAX_PROPERTIES, { message: `at most ${MAX_PROPERTIES} properties` })
  }) as unknown as z.ZodType<ObjectSchema>;
}

export const docmosisSchema: z.ZodType<DocmosisSchema> = z.strictObject({
  root: objectField(1),
  warnings: texts(MAX_WARNINGS, MAX_TEXT)
});

const utf8 = new TextEncoder();

const storable = (text: string): boolean => jsonbText(text) !== undefined;

const DOCX_REF_RE = /^sha256:([0-9a-f]{64})$/;

/** The hex digest a version's `docx` names, or `undefined` when it is not `sha256:` and 64 lowercase hex digits. */
export function docxSha(ref: string): string | undefined {
  return DOCX_REF_RE.exec(ref)?.[1];
}

export function docxRef(sha: string): string {
  return `sha256:${sha}`;
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean => prefix.every((byte, at) => bytes[at] === byte);

/** A .docx is a zip: its first local file header. */
export function isDocx(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
}

/** `%PDF-`. */
export function isPdf(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
}

const storableText = (max: number) =>
  z.string().trim().min(1).max(max).refine(storable, { message: "must not contain a NUL character or half of a surrogate pair" });

/** The body of `PUT …/docmosis`, with the schema and the data left for `checkDocmosisPut`. */
export const docmosisPutBody = z.object({
  name: storableText(MAX_DOCMOSIS_NAME),
  docx: z.string().regex(DOCX_REF_RE, 'must be "sha256:" and the .docx\'s 64 lowercase hex digits'),
  schema: z.unknown(),
  data: z.unknown(),
  base_version: z.number().int().nonnegative(),
  base_revision: z.number().int().nonnegative().optional(),
  summary: storableText(MAX_SUMMARY).optional(),
  pick: z.uuid({ message: "must be the id of the template library pick this write loads" }).optional()
});

export interface DocmosisPut {
  name: string;
  docx: string;
  schema: DocmosisSchema;
  data: Record<string, unknown>;
  base_version: number;
  base_revision?: number;
  summary?: string;
  /** The `docmosis.load` pod job this write loads a template for, which records it as the person's own pick. */
  pick?: string;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

function issueText(field: string, issue: z.core.$ZodIssue): string {
  const where = issue.path.map((part) => (typeof part === "number" ? `[${part}]` : `.${String(part)}`)).join("");
  return `${field}${where} ${issue.message}`;
}

/** The size `text` will have in a jsonb column: the UTF-8 of the value as Postgres prints it. */
function storedSize(field: string, value: unknown, max: number): string | undefined {
  const text = jsonbText(value);
  if (text === undefined) {
    return `${field} has text the hub cannot store: a NUL character, or half of a surrogate pair`;
  }
  return utf8.encode(text).byteLength > max ? `${field} is larger than ${max} bytes` : undefined;
}

export function checkDocmosisSchema(value: unknown): Checked<DocmosisSchema> {
  const parsed = docmosisSchema.safeParse(value);
  if (!parsed.success) {
    const [first] = parsed.error.issues;
    return { ok: false, error: first === undefined ? "schema is not valid" : issueText("schema", first) };
  }
  const refused = storedSize("schema", parsed.data, MAX_SCHEMA_BYTES);
  return refused === undefined ? { ok: true, value: parsed.data } : { ok: false, error: refused };
}

/** Whether `value` nests more than `max` levels of array or object, walked without recursion. */
function nestsDeeperThan(value: unknown, max: number): boolean {
  let level: unknown[] = [value];
  for (let depth = 0; level.length > 0; depth += 1) {
    const next: unknown[] = [];
    for (const item of level) {
      if (item !== null && typeof item === "object") {
        if (depth >= max) {
          return true;
        }
        next.push(...Object.values(item));
      }
    }
    level = next;
  }
  return false;
}

export function checkDocmosisData(value: unknown): Checked<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "data must be an object" };
  }
  if (nestsDeeperThan(value, MAX_DATA_DEPTH)) {
    return { ok: false, error: `data nests more than ${MAX_DATA_DEPTH} levels` };
  }
  const refused = storedSize("data", value, MAX_DATA_BYTES);
  return refused === undefined ? { ok: true, value: value as Record<string, unknown> } : { ok: false, error: refused };
}

/** The body of `PUT …/docmosis`, once every part is one the hub can store; otherwise the first problem, worded. */
export function checkDocmosisPut(value: unknown): Checked<DocmosisPut> {
  const parsed = docmosisPutBody.safeParse(value);
  if (!parsed.success) {
    const [first] = parsed.error.issues;
    return {
      ok: false,
      error: first === undefined ? "the request body is not valid" : issueText(String(first.path[0] ?? "body"), { ...first, path: first.path.slice(1) })
    };
  }
  const schema = checkDocmosisSchema(parsed.data.schema);
  if (!schema.ok) {
    return schema;
  }
  const data = checkDocmosisData(parsed.data.data);
  if (!data.ok) {
    return data;
  }
  const { schema: _schema, data: _data, ...rest } = parsed.data;
  return { ok: true, value: { ...rest, schema: schema.value, data: data.value } };
}

/** A merge error as it is stored, its texts cut to what the column takes and cleaned of NULs and lone surrogates, which Postgres cannot hold. */
export function storableError(error: { short: string; long: string }): { short: string; long: string } {
  const clean = (text: string, max: number) =>
    Array.from(text.replaceAll(String.fromCharCode(0), "").toWellFormed().normalize())
      .slice(0, max)
      .join("");
  return { short: clean(error.short, MAX_ERROR_SHORT), long: clean(error.long, MAX_ERROR_LONG) };
}
