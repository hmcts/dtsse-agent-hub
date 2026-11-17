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
import { ApiError } from "../api.ts";
import { CLI } from "../envelope.ts";
import { type RetryOptions, withRetry } from "../retry.ts";
import { requireSessionId } from "../session.ts";
import type { DocmosisResponse, DocmosisSchema } from "../wire.ts";
import { type Cli, type Command, parseFlags, refuseSecrets, requireAgent, UsageError } from "./command.ts";

/** The hub's limits, checked here so a file too big is refused before it is sent. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_JSON_BYTES = 120_000;
const MAX_NAME = 200;
const MAX_SUMMARY = 200;
const DOCX_REF_RE = /^sha256:([0-9a-f]{64})$/;
/** How often a PDF is sent before giving up: the version is already published, and putting again would publish another. */
export const PDF_RETRY: RetryOptions = { attempts: 3, baseMs: 500 };

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function noAsset(e: unknown): never {
  if (e instanceof ApiError && e.status === 404) {
    throw new Error("the hub does not hold that .docx");
  }
  throw e;
}

function noDocmosis(e: unknown): never {
  if (e instanceof ApiError && e.status === 404) {
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

function readFile(file: string, what: string, limit = MAX_FILE_BYTES): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = fs.readFileSync(file);
  } catch (e) {
    throw new UsageError(`cannot read ${what} ${file}: ${(e as Error).message}`);
  }
  if (bytes.byteLength > limit) {
    throw new UsageError(`${what} ${file} is larger than the hub takes, ${limit} bytes`);
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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`${file} must hold the ${what} object`);
  }
  // The hub measures the JSON it stores, not the file's formatting.
  if (Buffer.byteLength(JSON.stringify(parsed)) > MAX_JSON_BYTES) {
    throw new UsageError(`${what} ${file} is larger than the hub takes, ${MAX_JSON_BYTES} bytes as compact JSON`);
  }
  refuseSecrets(text);
  return parsed as Record<string, unknown>;
}

function readSchema(file: string): DocmosisSchema {
  const schema = readJsonObject(file, "schema");
  if ((schema.root as { kind?: unknown } | undefined)?.kind !== "object") {
    throw new UsageError(`${file} is not a schema from docmosis schema: it has no root of kind "object"`);
  }
  return schema as unknown as DocmosisSchema;
}

function putArgs(argv: string[]): { file: string; flags: Record<string, string> } {
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
  if (flags.name !== undefined && (flags.name.trim() === "" || flags.name.length > MAX_NAME)) {
    throw new UsageError(`--name is 1 to ${MAX_NAME} characters`);
  }
  if (flags.summary !== undefined && (flags.summary.trim() === "" || flags.summary.length > MAX_SUMMARY)) {
    throw new UsageError(`--summary is 1 to ${MAX_SUMMARY} characters saying what changed`);
  }
  return { file, flags };
}

function readDocx(file: string): Uint8Array {
  const docx = readFile(file, "the template");
  if (!(docx[0] === 0x50 && docx[1] === 0x4b && docx[2] === 0x03 && docx[3] === 0x04)) {
    throw new UsageError(`${file} is not a .docx`);
  }
  return docx;
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
function printConflict(cli: Cli, base: number, current: DocmosisResponse | undefined, baseRevision: number | undefined): void {
  const by = current?.by ? `, last written by ${current.by === "user" ? "the user" : "this conversation"}` : "";
  if (baseRevision !== undefined && current?.version === base && current.revision !== baseRevision) {
    cli.printError(`agent-hub docmosis: the user has changed the data of version ${base} of the template since you read it. Nothing was saved.`);
  } else {
    cli.printError(`agent-hub docmosis: the template has changed since version ${base}: it is now version ${current?.version ?? "?"}${by}. Nothing was saved.`);
  }
  cli.printError(`Run ${CLI} docmosis get, merge your change into the data and template it writes, render it again, and put again.`);
}

async function putDocmosis(cli: Cli, argv: string[]): Promise<number> {
  const { file, flags } = putArgs(argv);
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
  let known = flags.name ?? recordedName(dir) ?? hubName;
  if (known === undefined && base > 0) {
    known = await api.getDocmosis(agent.agent_id).then(
      (current) => current.name,
      () => undefined
    );
  }
  const name = (known ?? path.basename(docxFile, path.extname(docxFile))).trim();
  if (name === "" || name.length > MAX_NAME) {
    throw new UsageError(`the template's name must be 1 to ${MAX_NAME} characters; give one with --name`);
  }
  // Only the revision `get` read, and only with the version it read: one taken from the hub now would let the put
  // over an amend it never saw, and one sent with another version could never match.
  const baseRevision = recorded !== undefined && base === recorded ? recordedNumber(dir, REVISION_FILE) : undefined;
  const digest = sha256(docx);
  const { asset } = await api.putDocmosisAsset(agent.agent_id, digest, docx).catch(noDocmosis);
  let written: { version: number; revision: number };
  try {
    written = await api.putDocmosis(agent.agent_id, {
      name,
      docx: asset,
      schema,
      data,
      base_version: base,
      ...(baseRevision === undefined ? {} : { base_revision: baseRevision }),
      ...(flags.summary === undefined ? {} : { summary: flags.summary.trim() })
    });
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 409)) {
      return noDocmosis(e);
    }
    printConflict(cli, base, e.body?.current as DocmosisResponse | undefined, baseRevision);
    return 1;
  }
  record(dir, written.version, written.revision, name);
  if (pdf !== undefined && pdfFile !== undefined) {
    try {
      await withRetry(() => api.putDocmosisPdf(agent.agent_id, written.version, pdf), PDF_RETRY);
    } catch (e) {
      cli.printError(`agent-hub docmosis: published the template as version ${written.version}, but its PDF did not reach the hub: ${(e as Error).message}`);
      cli.printError(
        `Do not put the template again, which would publish another version, unless you have changed it. The person can still render it from the panel; to send this PDF, put the template again with --pdf ${shellWord(pdfFile)}.`
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
  cli.print(`agent-hub: wrote version ${template.version} (revision ${template.revision}) of the template "${template.name}" to ${dir}`);
  cli.print(`template: ${files.docx}`);
  cli.print(`schema: ${files.schema}`);
  cli.print(`data: ${files.data}`);
  cli.print(`Last changed by ${who}; ${failure}; ${template.has_pdf ? "has a PDF" : "has no PDF"}.`);
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

export const docmosis: Command = async (cli, argv) => {
  const [action, ...rest] = argv;
  if (action === "get") {
    return getDocmosis(cli, rest);
  }
  if (action === "put") {
    return putDocmosis(cli, rest);
  }
  throw new UsageError("docmosis takes get or put");
};
