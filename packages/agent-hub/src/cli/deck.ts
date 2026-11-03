// `agent-hub deck`: a CFT Workspace conversation's slide deck, between the hub and the files the slides plugin builds
// from. The hub names each picture by the SHA-256 of its bytes; the plugin reads pictures from paths beside the
// outline. `get` writes the hub's outline out with its pictures downloaded beside it and named by path, so `slides
// build` runs on it unchanged, and `put` turns the paths back into uploaded pictures before it sends the outline.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Api, ApiError } from "../api.ts";
import { CLI } from "../envelope.ts";
import { requireSessionId } from "../session.ts";
import type { Deck, DeckOutline, DeckSlide } from "../wire.ts";
import { type Cli, type Command, parseFlags, refuseSecrets, requireAgent, UsageError } from "./command.ts";

/** The hub's limits on one picture and one .pptx, checked here so a file too big is refused before it is sent. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ASSET_RE = /^sha256:([0-9a-f]{64})$/;
const SLIDE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

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

/**
 * Downloads every picture the outline names into `dir/assets/`, and answers the outline with each `asset` replaced
 * by the picture's path relative to `outline.json`. A picture already there with the right digest is not fetched
 * again.
 */
async function materialise(api: Api, agentId: string, outline: DeckOutline, dir: string): Promise<DeckOutline> {
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
        const bytes = await api.deckAsset(agentId, sha);
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

function getArgs(argv: string[]): { json: boolean; slide: string | undefined } {
  const json = argv.includes("--json");
  const { flags, rest } = parseFlags(
    argv.filter((a) => a !== "--json"),
    ["slide"]
  );
  if (rest.length) {
    throw new UsageError(`unexpected argument: ${rest[0]}`);
  }
  if (flags.slide !== undefined && !SLIDE_ID_RE.test(flags.slide)) {
    throw new UsageError("--slide takes a slide's id, such as s_ab12");
  }
  return { json, slide: flags.slide };
}

async function getDeck(cli: Cli, argv: string[]): Promise<number> {
  const { json, slide } = getArgs(argv);
  const agent = requireAgent(requireSessionId(cli.env));
  const api = cli.api();
  const deck = await api.getDeck(agent.agent_id).catch(noDeck);
  if (deck.outline === null) {
    cli.printError(`agent-hub: the conversation has no slide deck yet (version ${deck.version})`);
    return slide === undefined ? 0 : 1;
  }
  const dir = deckDir(cli, agent.conversation_id ?? agent.agent_id);
  fs.mkdirSync(dir, { recursive: true });
  const outline = await materialise(api, agent.agent_id, deck.outline, dir);
  const file = path.join(dir, "outline.json");
  fs.writeFileSync(file, `${JSON.stringify(outline, null, 2)}\n`);
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
    cli.print(JSON.stringify({ title: deck.title, version: deck.version, updated_by: deck.updated_by, pptx: deck.pptx, dir, outline: file }));
    return 0;
  }
  cli.print(`agent-hub: wrote version ${deck.version} of the slide deck to ${file}, with its pictures beside it`);
  cli.print(`Change it there, build it with slides build, then publish it with ${CLI} deck put ${file} --pptx <deck.pptx> --base ${deck.version}`);
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
  const pptx = pptxFile === undefined ? undefined : readFile(pptxFile, "the deck");
  if (pptx !== undefined && !(pptx[0] === 0x50 && pptx[1] === 0x4b && pptx[2] === 0x03 && pptx[3] === 0x04)) {
    throw new UsageError(`${flags.pptx} is not a .pptx`);
  }
  const agent = requireAgent(requireSessionId(cli.env));
  const api = cli.api();
  const base = flags.base === undefined ? (await api.getDeck(agent.agent_id).catch(noDeck)).version : Number(flags.base);
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
  if (pptx !== undefined) {
    await api.putDeckPptx(agent.agent_id, written.version, pptx);
  }
  const built = pptx === undefined ? "; the person sees it as not built until a .pptx is put with --pptx" : ", with its .pptx";
  cli.print(`agent-hub: published the slide deck as version ${written.version}${built}`);
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
  throw new UsageError("deck takes get or put");
};
