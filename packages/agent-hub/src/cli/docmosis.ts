// `agent-hub docmosis`: a CFT Workspace conversation's Docmosis template, between the hub and the files the
// cft-docmosis-template tools work on. `put` uploads the .docx under the SHA-256 of its bytes, publishes it with the
// form schema `docmosis schema` printed and the data it was rendered with, then sends the PDF `docmosis render-file`
// made from it. `get` writes the latest version out, which is how the person's changes to the data are read.
// `get` also records the version and revision it wrote. `put` sends them as its base, so a version someone else wrote
// in between, or the person's amend of the one read, is refused rather than overwritten. The revision goes with the
// version `get` recorded, so it is sent only for a put on that version: an explicit `--base` naming any other is put
// on the hub's version check alone.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Api, ApiError } from "../api.ts";
import { CLI } from "../envelope.ts";
import { type RetryOptions, withRetry } from "../retry.ts";
import { requireSessionId } from "../session.ts";
import type { DocmosisResponse, DocmosisSchema, DocmosisWritten } from "../wire.ts";
import { type Cli, type Command, parseFlags, refuseSecrets, requireAgent, UsageError } from "./command.ts";

/** The hub's limits, checked here so a file too big is refused before it is sent. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_JSON_BYTES = 120_000;
const MAX_NAME = 200;
const MAX_SUMMARY = 200;
const DOCX_REF_RE = /^sha256:([0-9a-f]{64})$/;
/** How often a PDF is sent before giving up: the version is already published, and putting again would publish another. */
export const PDF_RETRY: RetryOptions = { attempts: 3, baseMs: 500 };

const utf8 = new TextEncoder();

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let at = 0; at < Math.min(a.length, b.length); at += 1) {
    if (a[at] !== b[at]) {
      return (a[at] ?? 0) - (b[at] ?? 0);
    }
  }
  return a.length - b.length;
}

/** Whether Postgres refuses this text as a jsonb is written: it holds a NUL, or half of a surrogate pair. */
const unstorable = (text: string): boolean =>
  text.includes(String.fromCharCode(0)) || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);

/**
 * `value` as Postgres prints a jsonb, which is what the hub measures against its limit: `", "` between items, `": "`
 * after a key, and an object's keys shortest first. A copy of the hub's `jsonbText`, which the client cannot import.
 * `undefined` for text a jsonb cannot hold.
 */
export function jsonbText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return unstorable(value) ? undefined : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map(jsonbText);
    return items.includes(undefined) ? undefined : `[${items.join(", ")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => ({ key, bytes: utf8.encode(key), text: jsonbText(item) }));
    if (entries.some((entry) => entry.text === undefined || unstorable(entry.key))) {
      return undefined;
    }
    entries.sort((a, b) => a.bytes.length - b.bytes.length || compareBytes(a.bytes, b.bytes));
    return `{${entries.map((entry) => `${JSON.stringify(entry.key)}: ${entry.text}`).join(", ")}}`;
  }
  return JSON.stringify(value);
}
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function noAsset(e: unknown): never {
  if (e instanceof ApiError && e.status === 404) {
    throw new Error("the hub does not hold that .docx");
  }
  throw e;
}

/** The hub has no CFT Workspace conversation for the agent, so no template to publish to. */
export class DocmosisConversationMissingError extends Error {}

function noConversation(agentId: string): (e: unknown) => never {
  return (e) => {
    if (e instanceof ApiError && e.status === 404) {
      throw new DocmosisConversationMissingError(`the hub has no CFT Workspace conversation for agent ${agentId}`);
    }
    throw e;
  };
}

function noDocmosis(e: unknown): never {
  if ((e instanceof ApiError && e.status === 404) || e instanceof DocmosisConversationMissingError) {
    throw new Error("this session is not a CFT Workspace conversation, so it has no template");
  }
  throw e;
}

/** Where `get` writes a conversation's template: one directory per conversation, under the home directory. */
export function docmosisDir(cli: Cli, conversation: string): string {
  return path.join(cli.env.HOME || os.homedir(), ".agent-hub", "docmosis", conversation);
}

const VERSION_FILE = "version";
const REVISION_FILE = "revision";
const NAME_FILE = "name";

function recordedNumber(dir: string, name: string): number | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, name), "utf8").trim();
  } catch {
    return undefined;
  }
  return /^\d+$/.test(text) ? Number(text) : undefined;
}

function recordedName(dir: string): string | undefined {
  try {
    return fs.readFileSync(path.join(dir, NAME_FILE), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function record(dir: string, version: number, revision: number | undefined, name: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, VERSION_FILE), `${version}\n`);
  fs.writeFileSync(path.join(dir, NAME_FILE), `${name}\n`);
  const file = path.join(dir, REVISION_FILE);
  if (revision === undefined) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.writeFileSync(file, `${revision}\n`);
}

/** A path as one word of a shell command, so a command printed for the session to run can be run as it stands. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_/.,:=+@%-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function checkSize(bytes: Uint8Array, what: string, source: string): Uint8Array {
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new UsageError(`${what} ${source} is larger than the hub takes, ${MAX_FILE_BYTES} bytes`);
  }
  return bytes;
}

function readBytes(file: string, what: string): Uint8Array {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    throw new UsageError(`cannot read ${what} ${file}: ${(e as Error).message}`);
  }
}

function readFile(file: string, what: string): Uint8Array {
  return checkSize(readBytes(file, what), what, file);
}

/**
 * `text` trimmed, as the hub stores it, once it is one the hub's `storableText` takes: 1 to `max` characters after the
 * trim, with no NUL or half of a surrogate pair. Otherwise a `UsageError`: `refusal` for its length, or one naming
 * `label` for its characters.
 */
function storableText(text: string, max: number, refusal: string, label: string): string {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.length > max) {
    throw new UsageError(refusal);
  }
  if (unstorable(trimmed)) {
    throw new UsageError(`${label} must not contain a NUL character or half of a surrogate pair`);
  }
  return trimmed;
}

/** The template's name, trimmed as the hub stores it; a `UsageError` for one the hub would refuse. */
export function checkName(name: string): string {
  return storableText(name, MAX_NAME, `the template's name must be 1 to ${MAX_NAME} characters`, "the template's name");
}

/** A version's summary, trimmed as the hub stores it; a `UsageError` for one the hub would refuse. */
export function checkSummary(summary: string): string {
  return storableText(summary, MAX_SUMMARY, `the summary must be 1 to ${MAX_SUMMARY} characters saying what changed`, "the summary");
}

const JSON_KEY_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * The hub's `MAX_DATA_DEPTH`: levels of object or array, the root the first. The schema is held to it as well, which
 * refuses no schema the hub takes, because the hub's schema shape nests fewer levels than this.
 */
const MAX_DEPTH = 64;

/** An object or array walked: the levels it nests, itself the first, and its bytes as `jsonbText` prints it. */
type Walked = { levels: number; bytes: number };

type Walk = { what: string; source: string; open: Set<object>; done: Map<object, Walked> };

function foreign(walk: Walk, found: string): never {
  throw new UsageError(`${walk.what} ${walk.source} holds ${found}, which JSON cannot carry`);
}

function cannotStore(walk: Walk): never {
  throw new UsageError(`${walk.what} ${walk.source} has text the hub cannot store: a NUL character, or half of a surrogate pair`);
}

const scalar = (value: unknown): Walked => ({ levels: 0, bytes: utf8.encode(JSON.stringify(value)).byteLength });

/**
 * Refuses what in `value`, at `depth` below the root, JSON cannot carry, a jsonb cannot hold, or the hub would find
 * nested too deeply; otherwise its levels and size. An object met again is not walked again, so a subtree shared many
 * times over costs what one does.
 */
function walkJson(value: unknown, at: string, depth: number, walk: Walk): Walked {
  if (value === null || typeof value === "boolean") {
    return scalar(value);
  }
  if (typeof value === "string") {
    return unstorable(value) ? cannotStore(walk) : scalar(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? scalar(value) : foreign(walk, `${value} at ${at}`);
  }
  if (typeof value !== "object") {
    return foreign(walk, `${value === undefined ? "undefined" : `a ${typeof value}`} at ${at}`);
  }
  if (walk.open.has(value)) {
    return foreign(walk, `a reference to itself at ${at}`);
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== (Array.isArray(value) ? Array.prototype : Object.prototype) && proto !== null) {
    return foreign(walk, `a ${(proto as { constructor?: { name?: string } }).constructor?.name || "non-plain"} object at ${at}`);
  }
  const known = walk.done.get(value);
  if (depth + (known?.levels ?? 1) > MAX_DEPTH) {
    throw new UsageError(`${walk.what} ${walk.source} nests more than ${MAX_DEPTH} levels`);
  }
  if (known !== undefined) {
    return known;
  }
  walk.open.add(value);
  let bytes = 0;
  let below = 0;
  let count = 0;
  const add = (item: Walked, keyBytes: number) => {
    bytes += keyBytes + item.bytes;
    below = Math.max(below, item.levels);
    count += 1;
  };
  if (Array.isArray(value)) {
    // A hole reads as undefined, which JSON would quietly write as null.
    for (let index = 0; index < value.length; index += 1) {
      add(walkJson(value[index], `${at}[${index}]`, depth + 1, walk), 0);
    }
  } else {
    for (const [key, item] of Object.entries(value)) {
      // JSON leaves out a property whose value is undefined, so the hub never sees it.
      if (item === undefined) {
        continue;
      }
      if (unstorable(key)) {
        cannotStore(walk);
      }
      const where = JSON_KEY_RE.test(key) ? `${at}.${key}` : `${at}[${JSON.stringify(key)}]`;
      add(walkJson(item, where, depth + 1, walk), scalar(key).bytes + ": ".length);
    }
  }
  const walked = { levels: below + 1, bytes: bytes + "[]".length + ", ".length * Math.max(count - 1, 0) };
  walk.open.delete(value);
  walk.done.set(value, walked);
  return walked;
}

/**
 * Refuses, with a `UsageError` naming `source`, a value the hub would not store as the template's `what`: not an
 * object, holding something JSON cannot carry, text a jsonb cannot hold, nested more than the hub's limit, larger than
 * the hub's limit as Postgres prints it, or holding secret-shaped text.
 */
export function checkJsonObject(value: unknown, what: string, source: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UsageError(`${source} must hold the ${what} object`);
  }
  // The hub measures the JSON as Postgres stores it, not the file's formatting.
  const { bytes } = walkJson(value, "$", 0, { what, source, open: new Set(), done: new Map() });
  if (bytes > MAX_JSON_BYTES) {
    throw new UsageError(`${what} ${source} is larger than the hub takes, ${MAX_JSON_BYTES} bytes as the hub stores it`);
  }
  // The walk has refused everything a jsonb cannot hold, so this is text, and its size is known to be small. Building
  // it before the size check would expand every shared subtree.
  const stored = jsonbText(value) as string;
  try {
    refuseSecrets(stored);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  return value as Record<string, unknown>;
}

function schemaRoot(schema: Record<string, unknown>, source: string): DocmosisSchema {
  if ((schema.root as { kind?: unknown } | undefined)?.kind !== "object") {
    throw new UsageError(`${source} is not a schema from docmosis schema: it has no root of kind "object"`);
  }
  return schema as unknown as DocmosisSchema;
}

/** `checkJsonObject` for the form schema, which must also be one `docmosis schema` wrote. */
export function checkSchemaObject(value: unknown, source: string): DocmosisSchema {
  return schemaRoot(checkJsonObject(value, "schema", source), source);
}

/** Refuses, with a `UsageError` naming `source`, bytes the hub would not take as the template's .docx. */
export function checkDocx(bytes: Uint8Array, source: string): Uint8Array {
  checkSize(bytes, "the template", source);
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)) {
    throw new UsageError(`${source} is not a .docx`);
  }
  return bytes;
}

function readJsonObject(file: string, what: string): Record<string, unknown> {
  const text = new TextDecoder().decode(readFile(file, what));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  return checkJsonObject(parsed, what, file);
}

function readSchema(file: string): DocmosisSchema {
  return schemaRoot(readJsonObject(file, "schema"), file);
}

type PutArgs = { file: string; flags: Record<string, string>; name?: string; summary?: string };

function putArgs(argv: string[]): PutArgs {
  const { flags, rest } = parseFlags(argv, ["schema", "data", "pdf", "name", "summary", "base"]);
  const [file, ...extra] = rest;
  if (!file) {
    throw new UsageError("docmosis put takes the .docx file");
  }
  if (extra.length) {
    throw new UsageError(`unexpected argument: ${extra[0]}`);
  }
  if (flags.schema === undefined || flags.data === undefined) {
    throw new UsageError("docmosis put needs --schema, the file docmosis schema wrote, and --data, the JSON the template was rendered with");
  }
  if (flags.base !== undefined && !/^\d+$/.test(flags.base)) {
    throw new UsageError("--base must be a version number");
  }
  return {
    file,
    flags,
    name: flags.name === undefined ? undefined : storableText(flags.name, MAX_NAME, `--name is 1 to ${MAX_NAME} characters`, "--name"),
    summary:
      flags.summary === undefined
        ? undefined
        : storableText(flags.summary, MAX_SUMMARY, `--summary is 1 to ${MAX_SUMMARY} characters saying what changed`, "--summary")
  };
}

function readDocx(file: string): Uint8Array {
  return checkDocx(readBytes(file, "the template"), file);
}

function readPdf(file: string): Uint8Array {
  const pdf = readFile(file, "the PDF");
  if (new TextDecoder("latin1").decode(pdf.subarray(0, 5)) !== "%PDF-") {
    throw new UsageError(`${file} is not a PDF`);
  }
  return pdf;
}

/**
 * Says why a put was refused: for a newer version or, when the revision was sent and the version still matches, for the
 * person's amend of the one read, and how to put the change again on top of it.
 */
function printConflict(cli: Cli, base: number, current: DocmosisResponse | null, baseRevision: number | undefined): void {
  const by = current?.by ? `, last written by ${current.by === "user" ? "the user" : "this conversation"}` : "";
  if (baseRevision !== undefined && current?.version === base && current.revision !== baseRevision) {
    cli.printError(`agent-hub docmosis: the user has changed the data of version ${base} of the template since you read it. Nothing was saved.`);
  } else {
    cli.printError(`agent-hub docmosis: the template has changed since version ${base}: it is now version ${current?.version ?? "?"}${by}. Nothing was saved.`);
  }
  cli.printError(`Run ${CLI} docmosis get, merge your change into the data and template it writes, render it again, and put again.`);
}

export type DocmosisPublishInput = {
  docx: Uint8Array;
  schema: DocmosisSchema;
  data: Record<string, unknown>;
  name: string;
  /** The version the change builds on: 0 for a conversation with no template yet. */
  base: number;
  /** The revision read with `base`, so the person's amend since is refused rather than overwritten. */
  baseRevision?: number;
  summary?: string;
  /** The `docmosis.load` pod job this publishes a template for, which the hub records as the person's own pick. */
  pick?: string;
};

/**
 * `conflict` is given when the hub says the template has changed since `base`. Its `current` is the template as it is
 * now, or `null` when the hub did not say. With a `pick` an earlier run of its job already loaded, `written` is
 * the version that run wrote.
 */
export type DocmosisPublishResult = { written: DocmosisWritten } | { conflict: { current: DocmosisResponse | null } };

/**
 * Uploads the .docx under the SHA-256 of its bytes, then publishes it as a new version on top of `base`. The name and
 * summary are checked and trimmed here, before anything is sent. The .docx, schema and data are not: `checkDocx`,
 * `checkSchemaObject` and `checkJsonObject` apply the hub's limits first. Throws `DocmosisConversationMissingError`
 * when the hub has no conversation for the agent.
 */
export async function publishDocmosis(
  api: Pick<Api, "putDocmosisAsset" | "putDocmosis">,
  agentId: string,
  input: DocmosisPublishInput
): Promise<DocmosisPublishResult> {
  return publish(api, agentId, { ...input, name: checkName(input.name), summary: input.summary === undefined ? undefined : checkSummary(input.summary) });
}

/** `publishDocmosis` for a name and summary already checked. */
async function publish(api: Pick<Api, "putDocmosisAsset" | "putDocmosis">, agentId: string, input: DocmosisPublishInput): Promise<DocmosisPublishResult> {
  const missing = noConversation(agentId);
  const { asset } = await api.putDocmosisAsset(agentId, sha256(input.docx), input.docx).catch(missing);
  try {
    const written = await api.putDocmosis(agentId, {
      name: input.name,
      docx: asset,
      schema: input.schema,
      data: input.data,
      base_version: input.base,
      ...(input.baseRevision === undefined ? {} : { base_revision: input.baseRevision }),
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      ...(input.pick === undefined ? {} : { pick: input.pick })
    });
    return { written };
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 409)) {
      return missing(e);
    }
    // The pick was loaded by an earlier run of the same job, which wrote this version; nothing is written again.
    if (input.pick !== undefined && e.body?.loaded !== undefined) {
      return { written: e.body.loaded };
    }
    return { conflict: { current: (e.body?.current as DocmosisResponse | undefined) ?? null } };
  }
}

async function putDocmosis(cli: Cli, argv: string[]): Promise<number> {
  const { file, flags, name: named, summary } = putArgs(argv);
  const docxFile = path.resolve(cli.cwd(), file);
  const docx = readDocx(docxFile);
  const schema = readSchema(path.resolve(cli.cwd(), flags.schema as string));
  const data = readJsonObject(path.resolve(cli.cwd(), flags.data as string), "data");
  const pdfFile = flags.pdf === undefined ? undefined : path.resolve(cli.cwd(), flags.pdf);
  const pdf = pdfFile === undefined ? undefined : readPdf(pdfFile);
  const agent = requireAgent(requireSessionId(cli.env));
  const api = cli.api();
  const dir = docmosisDir(cli, agent.conversation_id ?? agent.agent_id);
  const recorded = recordedNumber(dir, VERSION_FILE);
  let base: number;
  let hubName: string | undefined;
  if (flags.base !== undefined) {
    base = Number(flags.base);
  } else if (recorded !== undefined) {
    base = recorded;
  } else {
    base = await api.getDocmosis(agent.agent_id).then(
      (current) => {
        hubName = current.name;
        return current.version;
      },
      (e: unknown) => (e instanceof ApiError && e.status === 404 && agent.conversation_id ? 0 : noDocmosis(e))
    );
  }
  let name = named;
  if (name === undefined) {
    let known = recordedName(dir) ?? hubName;
    if (known === undefined && base > 0) {
      known = await api.getDocmosis(agent.agent_id).then(
        (current) => current.name,
        () => undefined
      );
    }
    name = storableText(
      known ?? path.basename(docxFile, path.extname(docxFile)),
      MAX_NAME,
      `the template's name must be 1 to ${MAX_NAME} characters; give one with --name`,
      "the template's name"
    );
  }
  // Only the revision `get` read, and only with the version it read: one taken from the hub now would let the put
  // over an amend it never saw, and one sent with another version could never match.
  const baseRevision = recorded !== undefined && base === recorded ? recordedNumber(dir, REVISION_FILE) : undefined;
  const published = await publish(api, agent.agent_id, {
    docx,
    schema,
    data,
    name,
    base,
    baseRevision,
    summary
  }).catch(noDocmosis);
  if ("conflict" in published) {
    printConflict(cli, base, published.conflict.current, baseRevision);
    return 1;
  }
  const { written } = published;
  record(dir, written.version, written.revision, name);
  if (pdf !== undefined && pdfFile !== undefined) {
    try {
      await withRetry(() => api.putDocmosisPdf(agent.agent_id, written.version, written.revision, pdf), PDF_RETRY);
    } catch (e) {
      cli.printError(`agent-hub docmosis: published the template as version ${written.version}, but its PDF did not reach the hub: ${(e as Error).message}`);
      cli.printError(
        `Do not put the template again, which would publish another version. The person can still render it from the panel; to send this PDF, run ${CLI} docmosis pdf --version ${written.version} ${shellWord(pdfFile)}.`
      );
      return 1;
    }
  }
  const rendered =
    pdf === undefined
      ? "; the person sees no preview until it is rendered, which they can ask for in the panel, or until a PDF is put with --pdf"
      : ", with its PDF";
  cli.print(`agent-hub: published the template as version ${written.version}${rendered}`);
  return 0;
}

/**
 * Text the hub stored, fit to print on one line. The hub takes line breaks and control characters in a name or summary,
 * so whitespace is collapsed and any other control character, an escape sequence's ESC among them, is dropped.
 */
function oneLine(text: string): string {
  return text
    .replace(/(?!\s)\p{Cc}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getArgs(argv: string[]): { version: number | undefined } {
  const { flags, rest } = parseFlags(argv, ["version"]);
  if (rest.length) {
    throw new UsageError(`unexpected argument: ${rest[0]}`);
  }
  // Mirrors the hub's version parameter, which the client cannot import.
  if (flags.version !== undefined && !/^[1-9]\d{0,8}$/.test(flags.version)) {
    throw new UsageError("--version takes a version number from 1");
  }
  return { version: flags.version === undefined ? undefined : Number(flags.version) };
}

async function getDocmosis(cli: Cli, argv: string[]): Promise<number> {
  const { version } = getArgs(argv);
  const agent = requireAgent(requireSessionId(cli.env));
  const api = cli.api();
  let template: DocmosisResponse;
  try {
    template = await api.getDocmosis(agent.agent_id, version);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      cli.printError(
        version === undefined
          ? "agent-hub docmosis: the conversation has no template yet, or this session is not a CFT Workspace conversation"
          : `agent-hub docmosis: the template does not keep version ${version}, or the conversation has none`
      );
      return 1;
    }
    throw e;
  }
  const sha = DOCX_REF_RE.exec(template.docx)?.[1];
  if (sha === undefined) {
    throw new Error(`the hub named the template's .docx as ${template.docx}, which is not a sha256 digest`);
  }
  const docx = await api.docmosisAsset(agent.agent_id, sha).catch(noAsset);
  const dir = docmosisDir(cli, agent.conversation_id ?? agent.agent_id);
  fs.mkdirSync(dir, { recursive: true });
  // An older version is written beside the working copy rather than over it.
  const isLatest = template.current_version === undefined || template.current_version === template.version;
  const suffix = isLatest ? "" : `-v${template.version}`;
  const files = { docx: path.join(dir, `template${suffix}.docx`), schema: path.join(dir, `schema${suffix}.json`), data: path.join(dir, `data${suffix}.json`) };
  fs.writeFileSync(files.docx, docx);
  fs.writeFileSync(files.schema, `${JSON.stringify(template.schema, null, 2)}\n`);
  fs.writeFileSync(files.data, `${JSON.stringify(template.data, null, 2)}\n`);
  // The recorded version is what the working copy builds on, so reading an older version leaves it alone.
  if (isLatest) {
    record(dir, template.version, template.revision, template.name);
  }
  const who = template.by === "user" ? "the user" : "this conversation";
  const failure = template.render_error === null ? "no render error" : `render error: ${template.render_error.short}`;
  cli.print(`agent-hub: wrote version ${template.version} (revision ${template.revision}) of the template "${oneLine(template.name)}" to ${dir}`);
  cli.print(`template: ${files.docx}`);
  cli.print(`schema: ${files.schema}`);
  cli.print(`data: ${files.data}`);
  cli.print(`Last changed by ${who}; ${failure}; ${template.has_pdf ? "has a PDF" : "has no PDF"}.`);
  if (template.summary) {
    cli.print(`Summary: ${oneLine(template.summary)}`);
  }
  if (!isLatest) {
    cli.print(
      `This is not the latest version, which is ${template.current_version}, and the recorded base is unchanged. To bring it back, put it with ${CLI} docmosis put ${shellWord(files.docx)} --schema ${shellWord(files.schema)} --data ${shellWord(files.data)} --base ${template.current_version}`
    );
    return 0;
  }
  cli.print(
    `Change the data or the template there, check it with docmosis schema and render it with docmosis render-file, then publish it with ${CLI} docmosis put ${shellWord(files.docx)} --schema ${shellWord(files.schema)} --data ${shellWord(files.data)} [--pdf <file.pdf>], which puts it as a change to version ${template.version} and is refused if someone has written a newer one`
  );
  return 0;
}

function pdfArgs(argv: string[]): { file: string; version: number } {
  const { flags, rest } = parseFlags(argv, ["version"]);
  const [file, ...extra] = rest;
  if (!file) {
    throw new UsageError("docmosis pdf takes the PDF file");
  }
  if (extra.length) {
    throw new UsageError(`unexpected argument: ${extra[0]}`);
  }
  if (flags.version === undefined || !/^[1-9]\d{0,8}$/.test(flags.version)) {
    throw new UsageError("docmosis pdf needs --version, the version the PDF was rendered from");
  }
  return { file, version: Number(flags.version) };
}

/** Sends the PDF rendered from a version already published, which is how a `put` whose PDF failed is finished. */
async function putPdf(cli: Cli, argv: string[]): Promise<number> {
  const { file, version } = pdfArgs(argv);
  const pdf = readPdf(path.resolve(cli.cwd(), file));
  const agent = requireAgent(requireSessionId(cli.env));
  const api = cli.api();
  const missing = () => {
    cli.printError(`agent-hub docmosis: the template does not keep version ${version}, or this session is not a CFT Workspace conversation. Nothing was sent.`);
    return 1;
  };
  let revision: number;
  try {
    revision = (await api.getDocmosis(agent.agent_id, version)).revision;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      return missing();
    }
    throw e;
  }
  try {
    await withRetry(() => api.putDocmosisPdf(agent.agent_id, version, revision, pdf), PDF_RETRY);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      cli.printError(
        `agent-hub docmosis: version ${version} of the template changed while the PDF was being sent, so the PDF may no longer match it. Nothing was sent. Run ${CLI} docmosis get again.`
      );
      return 1;
    }
    if (e instanceof ApiError && e.status === 404) {
      return missing();
    }
    throw e;
  }
  cli.print(`agent-hub: sent the PDF for version ${version} of the template`);
  return 0;
}

export const docmosis: Command = async (cli, argv) => {
  const [action, ...rest] = argv;
  if (action === "get") {
    return getDocmosis(cli, rest);
  }
  if (action === "put") {
    return putDocmosis(cli, rest);
  }
  if (action === "pdf") {
    return putPdf(cli, rest);
  }
  throw new UsageError("docmosis takes get, put or pdf");
};
