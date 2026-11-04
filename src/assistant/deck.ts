import { z } from "zod";
import { boundedArray } from "../agent-api/bounded-array.ts";
import { MAX_BODY } from "../messages/limits.ts";
import { clip } from "./downloads.ts";
import type { Outline } from "./slides/masters.ts";

/**
 * A conversation's slide deck as the hub keeps it: the outline the slides plugin builds a .pptx from, with each picture
 * named by the SHA-256 of bytes the hub holds rather than by a path on the pod's disk. The plugin's own checks are in
 * `packages/agent-hub/plugins/slides/scripts/slides-lib/outline.ts`; the schema below refuses what they refuse as
 * errors, and leaves their word-count warnings to the plugin, since a crowded slide still renders.
 */

/** The migration's CHECK on `assistant_deck_version.outline`: the bytes of the jsonb's text, as Postgres prints it. */
export const MAX_OUTLINE_BYTES = 200_000;
export const MAX_SLIDES = 100;
export const MAX_DECK_TITLE = 200;
export const MAX_SUMMARY = 200;
/** One picture, and one .pptx: the migration's CHECKs. */
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;
export const MAX_PPTX_BYTES = 5 * 1024 * 1024;
/** The pictures a deck is using: those its latest version names, and those still in their upload grace. */
export const MAX_DECK_ASSET_BYTES = 20 * 1024 * 1024;
/**
 * Every picture a conversation holds, those only older versions name included. An upload that would pass it drops the
 * oldest versions, never the newest `KEEP_PPTX`, until the pictures no kept version names leave room, and is refused
 * when they cannot.
 */
export const MAX_HELD_ASSET_BYTES = 60 * 1024 * 1024;
/** A picture's width and height, each: a JPEG or GIF header cannot say more, and the columns are INTEGER. */
export const MAX_IMAGE_SIDE = 65_535;
/** How many versions of an outline are kept, and how many of the newest keep their .pptx. */
export const KEEP_VERSIONS = 100;
export const KEEP_PPTX = 3;
/**
 * How long a picture nothing names yet survives a write's clean-up. A client uploads the pictures before the outline
 * that names them, so without this a write landing between the two would delete what the next one is about to name.
 */
export const ASSET_GRACE_MS = 60 * 60 * 1000;

const MAX_TEXT = 500;
const MAX_NOTES = 10_000;
const MAX_ALT = 1000;
const MAX_BULLETS = 30;

const SHA256_RE = /^[0-9a-f]{64}$/;
const ASSET_RE = /^sha256:([0-9a-f]{64})$/;
/** A slide id stays readable inside a slide reference and on a command line. */
export const SLIDE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim() !== "", "must be non-empty text");

const bullet = z.union([text(MAX_TEXT), z.strictObject({ text: text(MAX_TEXT), bullets: boundedArray(text(MAX_TEXT), MAX_BULLETS).optional() })]);
const bullets = boundedArray(bullet, MAX_BULLETS, { min: 1, message: `at most ${MAX_BULLETS} bullets` });

const asset = z.string().regex(ASSET_RE, 'must be "sha256:" and the picture\'s 64 lowercase hex digits');
/** The plugin's `{path, alt}` or `{path, decorative: true}`, with `asset` in place of `path`. */
const image = z.union(
  [
    z.strictObject({ asset, alt: text(MAX_ALT), decorative: z.literal(false).optional() }),
    z.strictObject({ asset, decorative: z.literal(true), alt: z.string().max(MAX_ALT).optional() })
  ],
  { error: "must be {asset, alt} or {asset, decorative: true}: give alt text saying what the picture shows" }
);

const common = {
  id: z.string().regex(SLIDE_ID_RE, "must be 1–64 letters, digits, '.', '_' or '-'").optional(),
  notes: z.string().max(MAX_NOTES).optional()
};

/** One schema per slide layout of `MASTERS`, each taking exactly its placeholders' fields; `deck.test.ts` holds them to it. */
export const SLIDE_SCHEMAS = {
  HMCTS_SECTION: z.strictObject({ ...common, layout: z.literal("HMCTS_SECTION"), title: text(MAX_DECK_TITLE) }),
  HMCTS_CONTENT: z.strictObject({ ...common, layout: z.literal("HMCTS_CONTENT"), title: text(MAX_DECK_TITLE), bullets }),
  HMCTS_TWO_COLUMN: z.strictObject({ ...common, layout: z.literal("HMCTS_TWO_COLUMN"), title: text(MAX_DECK_TITLE), left: bullets, right: bullets }),
  HMCTS_IMAGE: z.strictObject({ ...common, layout: z.literal("HMCTS_IMAGE"), title: text(MAX_DECK_TITLE), image, caption: text(MAX_TEXT).optional() }),
  HMCTS_CLOSING: z.strictObject({ ...common, layout: z.literal("HMCTS_CLOSING"), title: text(MAX_DECK_TITLE), subtitle: text(MAX_TEXT).optional() })
} as const;

const slide = z.discriminatedUnion(
  "layout",
  [SLIDE_SCHEMAS.HMCTS_SECTION, SLIDE_SCHEMAS.HMCTS_CONTENT, SLIDE_SCHEMAS.HMCTS_TWO_COLUMN, SLIDE_SCHEMAS.HMCTS_IMAGE, SLIDE_SCHEMAS.HMCTS_CLOSING],
  {
    error: `layout must be one of ${Object.keys(SLIDE_SCHEMAS).join(", ")}; the title slide is made from the outline's own title and subtitle`
  }
);

export const deckOutline = z.strictObject({
  title: text(MAX_DECK_TITLE),
  subtitle: text(MAX_TEXT).optional(),
  notes: z.string().max(MAX_NOTES).optional(),
  slides: boundedArray(slide, MAX_SLIDES, {
    min: 1,
    message: `at most ${MAX_SLIDES} slides`,
    refine: {
      // Ids are how a person points the session at one slide, so two slides with one id would be one slide.
      check: (slides) => {
        const ids = slides.flatMap((one) => (one.id === undefined ? [] : [one.id]));
        return new Set(ids).size === ids.length;
      },
      message: "two slides have the same id"
    }
  })
});

export type DeckSlide = z.output<(typeof SLIDE_SCHEMAS)[keyof typeof SLIDE_SCHEMAS]>;
export interface DeckOutline {
  title: string;
  subtitle?: string;
  notes?: string;
  slides: DeckSlide[];
}

export const deckPutBody = z.object({
  outline: z.unknown(),
  base_version: z.number().int().nonnegative(),
  base_revision: z.number().int().nonnegative().optional(),
  summary: z.string().trim().min(1).max(MAX_SUMMARY).optional()
});

export type OutlineCheck = { ok: true; outline: DeckOutline } | { ok: false; error: string };

function issueText(issue: z.core.$ZodIssue): string {
  const where = issue.path.map((part) => (typeof part === "number" ? `[${part}]` : `.${String(part)}`)).join("");
  return `outline${where} ${issue.message}`;
}

const utf8 = new TextEncoder();

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let at = 0; at < Math.min(a.length, b.length); at += 1) {
    if (a[at] !== b[at]) {
      return (a[at] ?? 0) - (b[at] ?? 0);
    }
  }
  return a.length - b.length;
}

/** Half of a surrogate pair, which a jsonb cannot hold. */
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Whether Postgres refuses this text as a jsonb is written: it holds a NUL, or half of a surrogate pair. */
const unstorable = (text: string): boolean => text.includes(String.fromCharCode(0)) || LONE_SURROGATE_RE.test(text);

/**
 * `value` as Postgres prints a jsonb, which is what the column's CHECK measures: `", "` between items, `": "` after a
 * key, and an object's keys shortest first, then by their bytes. Strings are escaped as `JSON.stringify` escapes them.
 * `undefined` for text a jsonb cannot hold at all.
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

/**
 * The outline with an id on every slide, once it is one the plugin could build and it fits the column as it will be
 * stored, ids and all; otherwise the first problem, worded.
 */
export function checkOutline(value: unknown, random: () => number = Math.random): OutlineCheck {
  const parsed = deckOutline.safeParse(value);
  if (!parsed.success) {
    const [first] = parsed.error.issues;
    return { ok: false, error: first === undefined ? "the outline is not valid" : issueText(first) };
  }
  const outline = withSlideIds(parsed.data as DeckOutline, random);
  const stored = jsonbText(outline);
  if (stored === undefined) {
    return { ok: false, error: "the outline has text the hub cannot store: a NUL character, or half of a surrogate pair" };
  }
  if (utf8.encode(stored).byteLength > MAX_OUTLINE_BYTES) {
    return { ok: false, error: `the outline is larger than ${MAX_OUTLINE_BYTES} bytes` };
  }
  return { ok: true, outline };
}

/** A fresh id for a slide that came without one: short, so a slide reference stays readable. */
export function newSlideId(random: () => number = Math.random): string {
  return `s_${Math.floor(random() * 0x10000)
    .toString(16)
    .padStart(4, "0")}`;
}

/**
 * The outline with an id on every slide. A slide that came with one keeps it, so the session's own handles and the
 * references a person has already sent survive the write; one without is given a new id no other slide has.
 */
export function withSlideIds(outline: DeckOutline, random: () => number = Math.random): DeckOutline {
  const taken = new Set(outline.slides.flatMap((one) => (one.id === undefined ? [] : [one.id])));
  const slides = outline.slides.map((one) => {
    if (one.id !== undefined) {
      return one;
    }
    let id = newSlideId(random);
    for (let tries = 0; taken.has(id); tries += 1) {
      // Four hex digits run out long before MAX_SLIDES would collide often; a longer id ends a run of bad luck.
      id = tries < 16 ? newSlideId(random) : `${newSlideId(random)}${newSlideId(random).slice(2)}`;
    }
    taken.add(id);
    return { ...one, id };
  });
  return { ...outline, slides };
}

/** The hex digest an outline's `image.asset` names. */
export function assetSha(ref: string): string | undefined {
  return ASSET_RE.exec(ref)?.[1];
}

export function assetRef(sha: string): string {
  return `sha256:${sha}`;
}

export function isSha256(value: string): boolean {
  return SHA256_RE.test(value);
}

/** Every picture the outline names, once each, in the order they first appear. */
export function outlineAssets(outline: DeckOutline): string[] {
  const shas = outline.slides.flatMap((one) => (one.layout === "HMCTS_IMAGE" ? [assetSha(one.image.asset)] : []));
  return [...new Set(shas.filter((sha): sha is string => sha !== undefined))];
}

/**
 * The outline as `plan` in `slides/masters.ts` takes it, with each picture's `asset` turned into the address it is
 * drawn from. `plan` reads `image.path` as the picture's source, which is all it ever does with it.
 */
export function plannable(outline: DeckOutline, src: (sha: string) => string): Outline {
  return {
    ...outline,
    slides: outline.slides.map((one) => {
      if (one.layout !== "HMCTS_IMAGE") {
        return one;
      }
      const { asset: ref, ...rest } = one.image;
      return { ...one, image: { ...rest, path: src(assetSha(ref) ?? "") } as NonNullable<Outline["slides"][number]["image"]> };
    })
  };
}

export type ImageMime = "image/png" | "image/jpeg" | "image/gif";

export interface ImageInfo {
  mime: ImageMime;
  width: number;
  height: number;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (bytes: Uint8Array, magic: readonly number[]): boolean => magic.every((byte, index) => bytes[index] === byte);

const u16be = (bytes: Uint8Array, at: number): number => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
const u16le = (bytes: Uint8Array, at: number): number => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
const u32be = (bytes: Uint8Array, at: number): number => u16be(bytes, at) * 0x10000 + u16be(bytes, at + 2);

/** A JPEG's size, from its first start-of-frame segment. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      return undefined;
    }
    const marker = bytes[at + 1] ?? 0;
    // Fill bytes before a marker.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // SOF0–SOF15, less DHT (C4), JPG (C8) and DAC (CC), which share the range and carry no size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(bytes, at + 5), width: u16be(bytes, at + 7) };
    }
    at += 2 + u16be(bytes, at + 2);
  }
  return undefined;
}

/**
 * What a picture is, read from its bytes: one of the three types the plugin builds into a deck, and its size in
 * pixels, 1 to `MAX_IMAGE_SIDE` each way. Anything else is `undefined`. The type is what the hub serves the picture as, to the owner and to anyone
 * they share the chat with, so it is never taken from the uploader.
 */
export function imageInfo(bytes: Uint8Array): ImageInfo | undefined {
  let found: ImageInfo | undefined;
  if (bytes.length >= 24 && startsWith(bytes, PNG_MAGIC)) {
    found = { mime: "image/png", width: u32be(bytes, 16), height: u32be(bytes, 20) };
  } else if (bytes.length >= 10 && (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))) {
    found = { mime: "image/gif", width: u16le(bytes, 6), height: u16le(bytes, 8) };
  } else if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    const size = jpegSize(bytes);
    found = size === undefined ? undefined : { mime: "image/jpeg", ...size };
  }
  const fits = (side: number) => side >= 1 && side <= MAX_IMAGE_SIDE;
  return found !== undefined && fits(found.width) && fits(found.height) ? found : undefined;
}

/** A .pptx is a zip: its first local file header. */
export function isPptx(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
}

/** The longest a slide reference is, its titles cut to fit, so the composer can keep a fixed room for it. */
export const MAX_SLIDE_REFERENCE = 300;
/** What a message about a slide may hold of the person's words: `MAX_BODY` less the reference and its line break. */
export const MAX_ASKED_BODY = MAX_BODY - MAX_SLIDE_REFERENCE - 1;

/** `text`, or the longest start of it with an ellipsis, whose JSON string is at most `budget` inside its quotes. */
function fitQuoted(text: string, budget: number): string {
  const inside = (value: string) => JSON.stringify(value).length - 2;
  if (inside(text) <= budget) {
    return text;
  }
  for (let units = budget - 1; units > 0; units -= 1) {
    const cut = `${clip(text, units)}…`;
    if (inside(cut) <= budget) {
      return cut;
    }
  }
  return "…";
}

/**
 * The words a person's message starts with when they ask about one slide, which the session reads the slide by. Slide
 * 1 is the title slide, which is made from the outline's own fields and so has no id. At most `MAX_SLIDE_REFERENCE`:
 * the titles are cut to fit, each keeping half the room unless the other needs less, and never the id or version,
 * which the session reads the slide by.
 */
export function slideReference(deck: { title: string; version: number }, index: number, slideTitle: string, id: string | undefined): string {
  const which = id === undefined ? "" : `, id ${id}`;
  const reference = (deckTitle: string, title: string) =>
    `[Slide ${index + 1} of ${JSON.stringify(deckTitle)} v${deck.version}${which}: ${JSON.stringify(title)}]`;
  const whole = reference(deck.title, slideTitle);
  if (whole.length <= MAX_SLIDE_REFERENCE) {
    return whole;
  }
  const room = MAX_SLIDE_REFERENCE - reference("", "").length;
  const titleLength = JSON.stringify(slideTitle).length - 2;
  const deckBudget = Math.max(Math.floor(room / 2), room - titleLength);
  const deckTitle = fitQuoted(deck.title, deckBudget);
  return reference(deckTitle, fitQuoted(slideTitle, room - (JSON.stringify(deckTitle).length - 2)));
}
