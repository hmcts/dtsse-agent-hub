// `agent-hub deck`: a CFT Workspace conversation's slide deck, between the hub and the files the slides plugin builds
// from. The hub names each picture by the SHA-256 of its bytes; the plugin reads pictures from paths beside the
// outline. `get` writes the hub's outline out with its pictures downloaded beside it and named by path, so `slides
// build` runs on it unchanged, and `put` turns the paths back into uploaded pictures before it sends the outline.
// `get` also records the version it wrote, which `put` sends as its base for an outline in that directory, so a
// version someone else wrote in between is refused rather than overwritten.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Api, ApiError } from "../api.ts";
import { CLI } from "../envelope.ts";
import { type RetryOptions, withRetry } from "../retry.ts";
import { requireSessionId } from "../session.ts";
import type { Deck, DeckOutline, DeckSlide } from "../wire.ts";
import { type Cli, type Command, parseFlags, refuseSecrets, requireAgent, UsageError } from "./command.ts";

/** The hub's limits on one picture and one .pptx, checked here so a file too big is refused before it is sent. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ASSET_RE = /^sha256:([0-9a-f]{64})$/;
const SLIDE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/**
 * How often a .pptx is sent before giving up. Its outline is already published by then, so a failure is worth a few
 * more tries: putting the whole deck again would publish another version.
 */
export const PPTX_RETRY: RetryOptions = { attempts: 3, baseMs: 500 };

/** What a picture's own bytes say it is, which decides the extension it is saved under. */
function pictureExtension(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "png";
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "gif";
  }
  return "jpg";
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function noDeck(e: unknown): never {
  if (e instanceof ApiError && e.status === 404) {
    throw new Error("this session is not a CFT Workspace conversation, so it has no slide deck");
  }
  throw e;
}

/** Where `get` writes a conversation's deck: one directory per conversation, under the home directory. */
export function deckDir(cli: Cli, conversation: string): string {
  return path.join(cli.env.HOME || os.homedir(), ".agent-hub", "decks", conversation);
}

/** The file in the deck's directory naming the version its outline was read at, or last put as. */
const VERSION_FILE = "version";

function isInside(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function recordVersion(dir: string, version: number): void {
  fs.writeFileSync(path.join(dir, VERSION_FILE), `${version}\n`);
}

function recordedVersion(dir: string): number | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, VERSION_FILE), "utf8").trim();
  } catch {
    return undefined;
  }
  return /^\d+$/.test(text) ? Number(text) : undefined;
}

/**
 * Downloads every picture the outline names into `dir/assets/` with `fetchAsset`, and answers the outline with each
 * `asset` replaced by the picture's path relative to `outline.json`. A picture already there with the right digest is
 * not fetched again. A session's `deck get` and the supervisor's deck builds both write a deck out this way.
 */
export async function materialise(fetchAsset: (sha: string) => Promise<Uint8Array>, outline: DeckOutline, dir: string): Promise<DeckOutline> {
  const assets = path.join(dir, "assets");
  const fetched = new Map<string, string>();
  const slides: DeckSlide[] = [];
  for (const slide of outline.slides ?? []) {
    const sha = typeof slide.image?.asset === "string" ? ASSET_RE.exec(slide.image.asset)?.[1] : undefined;
    if (slide.image === undefined || sha === undefined) {
      slides.push(slide);
      continue;
    }
    let relative = fetched.get(sha);
    if (relative === undefined) {
      const existing = fs.existsSync(assets) ? fs.readdirSync(assets).find((name) => name.startsWith(`${sha}.`)) : undefined;
      if (existing !== undefined && sha256(fs.readFileSync(path.join(assets, existing))) === sha) {
        relative = `assets/${existing}`;
      } else {
        const bytes = await fetchAsset(sha);
        fs.mkdirSync(assets, { recursive: true });
        const name = `${sha}.${pictureExtension(bytes)}`;
        fs.writeFileSync(path.join(assets, name), bytes);
        relative = `assets/${name}`;
      }
      fetched.set(sha, relative);
    }
    const { asset: _asset, ...image } = slide.image;
    slides.push({ ...slide, image: { ...image, path: relative } });
  }
  return { ...outline, slides };
}

function getArgs(argv: string[]): { json: boolean; slide: string | undefined; version: number | undefined } {
  const json = argv.includes("--json");
  const { flags, rest } = parseFlags(
    argv.filter((a) => a !== "--json"),
    ["slide", "version"]
  );
  if (rest.length) {
    throw new UsageError(`unexpected argument: ${rest[0]}`);
  }
  if (flags.slide !== undefined && !SLIDE_ID_RE.test(flags.slide)) {
    throw new UsageError("--slide takes a slide's id, such as s_ab12");
  }
  // Mirrors the hub's `versionParam` (src/assistant/deck-build.ts), which the client cannot import.
  if (flags.version !== undefined && !/^[1-9]\d{0,8}$/.test(flags.version)) {
    throw new UsageError("--version takes a version number from 1");
  }
  return { json, slide: flags.slide, version: flags.version === undefined ? undefined : Number(flags.version) };
}

async function getDeck(cli: Cli, argv: string[]): Promise<number> {
  const { json, slide, version } = getArgs(argv);
  const agent = requireAgent(requireSessionId(cli.env));
  const api = cli.api();
  const deck = await api.getDeck(agent.agent_id, version).catch((e: unknown) => {
    if (version !== undefined && e instanceof ApiError && e.status === 404 && agent.conversation_id) {
      throw new Error(`the slide deck does not keep version ${version}; the hub keeps the latest 100`);
    }
    return noDeck(e);
  });
  if (deck.outline === null) {
    cli.printError(`agent-hub: the conversation has no slide deck yet (version ${deck.version})`);
    return slide === undefined ? 0 : 1;
  }
  const dir = deckDir(cli, agent.conversation_id ?? agent.agent_id);
  fs.mkdirSync(dir, { recursive: true });
  const outline = await materialise((sha) => api.deckAsset(agent.agent_id, sha), deck.outline, dir);
  // An older version is written beside the working copy rather than over it.
  const file = path.join(dir, version === undefined ? "outline.json" : `outline-v${deck.version}.json`);
  fs.writeFileSync(file, `${JSON.stringify(outline, null, 2)}\n`);
  // The recorded version is what the working copy builds on, so reading an older version leaves it alone.
  if (version === undefined) {
    recordVersion(dir, deck.version);
  }
  if (slide !== undefined) {
    const index = (outline.slides ?? []).findIndex((one) => one.id === slide);
    if (index === -1) {
      cli.printError(`agent-hub deck: version ${deck.version} has no slide with id ${slide}`);
      return 1;
    }
    // Slide 1 is the title slide, made from the outline's own title, so the outline's slides start at 2.
    cli.print(JSON.stringify({ version: deck.version, number: index + 2, outline: file, slide: outline.slides?.[index] }, null, 2));
    return 0;
  }
  if (json) {
    cli.print(
      JSON.stringify({
        title: deck.title,
        version: deck.version,
        updated_by: deck.updated_by,
        pptx: deck.pptx,
        dir,
        outline: file,
        ...(deck.latest_version === undefined ? {} : { latest_version: deck.latest_version })
      })
    );
    return 0;
  }
  if (deck.latest_version !== undefined && deck.latest_version !== deck.version) {
    cli.print(
      `agent-hub: wrote version ${deck.version} of the slide deck, which is not the latest (version ${deck.latest_version}), to ${file}, with its pictures beside it`
    );
    cli.print(`To bring it back, build it with slides build, then publish it with ${CLI} deck put ${file} --pptx <deck.pptx> --base ${deck.latest_version}`);
    return 0;
  }
  cli.print(`agent-hub: wrote version ${deck.version} of the slide deck to ${file}, with its pictures beside it`);
  cli.print(
    `Change it there, build it with slides build, then publish it with ${CLI} deck put ${shellWord(file)} --pptx <deck.pptx>, which puts it as a change to version ${deck.version} and is refused if someone has written a newer one`
  );
  return 0;
}

function putArgs(argv: string[]): { file: string; flags: Record<string, string> } {
  const { flags, rest } = parseFlags(argv, ["pptx", "base", "summary"]);
  const [file, ...extra] = rest;
  if (!file) {
    throw new UsageError("deck put takes the outline file");
  }
  if (extra.length) {
    throw new UsageError(`unexpected argument: ${extra[0]}`);
  }
  if (flags.base !== undefined && !/^\d+$/.test(flags.base)) {
    throw new UsageError("--base must be a version number");
  }
  if (flags.summary !== undefined && (flags.summary.trim() === "" || flags.summary.length > 200)) {
    throw new UsageError("--summary is 1 to 200 characters saying what changed");
  }
  return { file, flags };
}

function readFile(file: string, what: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = fs.readFileSync(file);
  } catch (e) {
    throw new UsageError(`cannot read ${what} ${file}: ${(e as Error).message}`);
  }
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new UsageError(`${what} ${file} is larger than the hub takes, ${MAX_FILE_BYTES} bytes`);
  }
  return bytes;
}

function readPptx(file: string, given: string): Uint8Array {
  const pptx = readFile(file, "the deck");
  if (!(pptx[0] === 0x50 && pptx[1] === 0x4b && pptx[2] === 0x03 && pptx[3] === 0x04)) {
    throw new UsageError(`${given} is not a .pptx`);
  }
  return pptx;
}

/** A path as one word of a shell command, so a command printed for the session to run can be run as it stands. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_/.,:=+@%-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function readOutline(file: string): DeckOutline {
  const text = new TextDecoder().decode(readFile(file, "the outline"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`${file} must hold the outline object`);
  }
  refuseSecrets(text);
  return parsed as DeckOutline;
}

/** Uploads every picture the outline names by path, once each, and answers the outline naming them by digest. */
async function uploadPictures(api: Api, agentId: string, outline: DeckOutline, baseDir: string): Promise<DeckOutline> {
  const uploaded = new Map<string, string>();
  const slides: DeckSlide[] = [];
  for (const slide of outline.slides ?? []) {
    const picture = slide.image?.path;
    if (slide.image === undefined || typeof picture !== "string") {
      slides.push(slide);
      continue;
    }
    const file = path.isAbsolute(picture) ? picture : path.resolve(baseDir, picture);
    let ref = uploaded.get(file);
    if (ref === undefined) {
      const bytes = readFile(file, "the picture");
      ref = (await api.putDeckAsset(agentId, sha256(bytes), bytes)).asset;
      uploaded.set(file, ref);
    }
    const { path: _path, ...image } = slide.image;
    slides.push({ ...slide, image: { ...image, asset: ref } });
  }
  return { ...outline, slides };
}

/** Says why a put was refused for a newer version, and how to put the change again on top of it. */
function printConflict(cli: Cli, base: number, current: Deck | undefined): void {
  const by = current?.updated_by ? `, last written by ${current.updated_by === "user" ? "the user" : "this conversation"}` : "";
  const again = current?.version === undefined ? "" : ` with --base ${current.version}`;
  cli.printError(`agent-hub deck: the deck has changed since version ${base}: it is now version ${current?.version ?? "?"}${by}. Nothing was saved.`);
  cli.printError(`Read it with ${CLI} deck get, make your change to that, build it, and put it again${again}.`);
}

/**
 * The ids the hub gave slides that had none, written back into the outline file, so the next put sends them and every
 * slide keeps its id. Nothing else in the file changes.
 */
function keepIds(file: string, local: DeckOutline, stored: DeckOutline): void {
  const slides = local.slides ?? [];
  let changed = false;
  slides.forEach((slide, index) => {
    const id = stored.slides?.[index]?.id;
    if (slide.id === undefined && typeof id === "string") {
      slide.id = id;
      changed = true;
    }
  });
  if (changed) {
    fs.writeFileSync(file, `${JSON.stringify(local, null, 2)}\n`);
  }
}

async function putDeck(cli: Cli, argv: string[]): Promise<number> {
  const { file, flags } = putArgs(argv);
  const outlineFile = path.resolve(cli.cwd(), file);
  const local = readOutline(outlineFile);
  const pptxFile = flags.pptx === undefined ? undefined : path.resolve(cli.cwd(), flags.pptx);
  const pptx = pptxFile === undefined ? undefined : readPptx(pptxFile, flags.pptx as string);
  const agent = requireAgent(requireSessionId(cli.env));
  const api = cli.api();
  const dir = deckDir(cli, agent.conversation_id ?? agent.agent_id);
  const fromGet = isInside(dir, outlineFile);
  // An outline `get` wrote is a change to the version it read; any other is a new deck, put on whatever is there.
  const recorded = fromGet ? recordedVersion(dir) : undefined;
  const base = flags.base !== undefined ? Number(flags.base) : recorded !== undefined ? recorded : (await api.getDeck(agent.agent_id).catch(noDeck)).version;
  const outline = await uploadPictures(api, agent.agent_id, local, path.dirname(outlineFile)).catch(noDeck);
  let written: { version: number; outline: DeckOutline };
  try {
    written = await api.putDeck(agent.agent_id, { outline, base_version: base, ...(flags.summary === undefined ? {} : { summary: flags.summary.trim() }) });
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 409)) {
      return noDeck(e);
    }
    printConflict(cli, base, e.body?.current as Deck | undefined);
    return 1;
  }
  keepIds(outlineFile, local, written.outline);
  if (fromGet) {
    recordVersion(dir, written.version);
  }
  if (pptx !== undefined && pptxFile !== undefined) {
    try {
      await withRetry(() => api.putDeckPptx(agent.agent_id, written.version, pptx), PPTX_RETRY);
    } catch (e) {
      cli.printError(`agent-hub deck: published the slide deck as version ${written.version}, but its .pptx did not reach the hub: ${(e as Error).message}`);
      cli.printError(
        `Do not put the outline again, which would publish another version. Send the .pptx alone: ${CLI} deck pptx ${shellWord(pptxFile)} --version ${written.version}`
      );
      return 1;
    }
  }
  const built = pptx === undefined ? "; the person sees it as not built until a .pptx is put with --pptx" : ", with its .pptx";
  cli.print(`agent-hub: published the slide deck as version ${written.version}${built}`);
  return 0;
}

function pptxArgs(argv: string[]): { file: string; version: number } {
  const { flags, rest } = parseFlags(argv, ["version"]);
  const [file, ...extra] = rest;
  if (!file) {
    throw new UsageError("deck pptx takes the .pptx file");
  }
  if (extra.length) {
    throw new UsageError(`unexpected argument: ${extra[0]}`);
  }
  if (flags.version === undefined || !/^[1-9]\d*$/.test(flags.version)) {
    throw new UsageError("deck pptx needs --version, the version the .pptx was built from");
  }
  return { file, version: Number(flags.version) };
}

/** Sends the .pptx built from a version already published, which is how a `deck put` whose .pptx failed is finished. */
async function putPptx(cli: Cli, argv: string[]): Promise<number> {
  const { file, version } = pptxArgs(argv);
  const pptx = readPptx(path.resolve(cli.cwd(), file), file);
  const agent = requireAgent(requireSessionId(cli.env));
  const api = cli.api();
  try {
    await withRetry(() => api.putDeckPptx(agent.agent_id, version, pptx), PPTX_RETRY);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      cli.printError(`agent-hub deck: version ${version} is older than the latest 3, which are the only ones the hub keeps a .pptx for. Nothing was sent.`);
      return 1;
    }
    if (e instanceof ApiError && e.status === 404) {
      cli.printError(`agent-hub deck: the deck has no version ${version}, or this session is not a CFT Workspace conversation. Nothing was sent.`);
      return 1;
    }
    throw e;
  }
  cli.print(`agent-hub: sent the .pptx for version ${version} of the slide deck`);
  return 0;
}

export const deck: Command = async (cli, argv) => {
  const [action, ...rest] = argv;
  if (action === "get") {
    return getDeck(cli, rest);
  }
  if (action === "put") {
    return putDeck(cli, rest);
  }
  if (action === "pptx") {
    return putPptx(cli, rest);
  }
  throw new UsageError("deck takes get, put or pptx");
};
