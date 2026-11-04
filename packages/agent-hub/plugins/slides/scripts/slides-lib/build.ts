/**
 * Writes a deck with pptxgenjs from `masters.ts`: each master becomes a slide layout of the deck's slide master, and
 * each planned box goes into its placeholder. Every position comes from `masters.ts`; this file only converts units
 * and fills placeholders, so the deck stays editable and on-brand in PowerPoint.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { imageSize } from "image-size";
import JSZip from "jszip";
import {
  type Box,
  BULLET_HANG,
  BULLET_INDENT,
  BULLETS,
  MASTERS,
  type Outline,
  type PlaceholderSpec,
  plan,
  type Run,
  SLIDE,
  type TextStyle
} from "./masters.ts";
import { formatOf, resolveImage } from "./outline.ts";
import { PptxGenJS, type Pres, type Slide, type TextProps } from "./pptx.ts";

const ASSETS = new URL("./assets/", import.meta.url);

/** A deck that could not be written for a reason the caller can put right: where it goes, or a picture it uses. */
export class DeckError extends Error {}

/** pptxgenjs takes positions in inches but insets and indents in points. */
const points = (inches: number): number => inches * 72;

/** Inches as the EMU the deck's XML is written in. */
const emu = (inches: number): number => Math.round(inches * 914400);

const hex = (char: string): string => (char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");

/** A bullet as pptxgenjs takes one: the character, and how far in its text starts. */
const bulletOf = (char: string) => ({ characterCode: hex(char), indent: points(BULLET_INDENT) });

/**
 * pptxgenjs has no way to mark a picture decorative and writes its file path as the description of a picture
 * without alt text, so a decorative picture is given this marker, replaced once the deck is written.
 */
const DECORATIVE_MARK = "slides-decorative-picture";
const DECORATIVE_EXT =
  '<a:extLst><a:ext uri="{C183D7F6-B498-43B3-948B-1728B52AA6E4}"><adec:decorative xmlns:adec="http://schemas.microsoft.com/office/drawing/2017/decorative" val="1"/></a:ext></a:extLst>';

/** The placeholders that hold bullets, by name. */
const BULLET_LISTS = new Set(MASTERS.flatMap((master) => master.placeholders.filter((spec) => spec.kind === "bullets").map((spec) => spec.name)));

/** The file extension pptxgenjs gives each picture format its content type by. */
const EXTENSIONS: Record<string, string> = { PNG: "png", JPEG: "jpg", GIF: "gif" };

function textOptions(style: TextStyle) {
  return {
    fontFace: style.fontFace,
    fontSize: style.fontSize,
    color: style.color,
    align: style.align,
    valign: style.valign,
    margin: points(style.inset),
    ...(style.lineSpacingMultiple === undefined ? {} : { lineSpacingMultiple: style.lineSpacingMultiple }),
    ...(style.paraSpaceAfter === undefined ? {} : { paraSpaceAfter: style.paraSpaceAfter })
  };
}

function placeholderType(spec: PlaceholderSpec): "title" | "body" | "pic" {
  if (spec.kind === "image") {
    return "pic";
  }
  return spec.name === "title" ? "title" : "body";
}

export function defineMasters(pptx: Pres): void {
  for (const master of MASTERS) {
    const background = "color" in master.background ? { color: master.background.color } : { path: fileURLToPath(new URL(master.background.image, ASSETS)) };
    const fixed = master.fixed.flatMap((box) =>
      box.kind === "rect" ? [{ rect: { x: box.x, y: box.y, w: box.w, h: box.h, fill: { color: box.style.fill }, line: { type: "none" as const } } }] : []
    );
    const placeholders = master.placeholders.map((spec) => ({
      placeholder: {
        // pptxgenjs 4.0.1 writes no type for a "pic" placeholder, so PowerPoint treats it as a content placeholder,
        // which takes a picture all the same.
        options: {
          name: spec.name,
          objectName: spec.name,
          type: placeholderType(spec),
          x: spec.x,
          y: spec.y,
          w: spec.w,
          h: spec.h,
          ...(spec.style ? textOptions(spec.style) : {}),
          // The first level's bullet, so text typed into the placeholder in PowerPoint is bulleted as the deck's is.
          ...(spec.kind === "bullets" ? { bullet: bulletOf(BULLETS[0]) } : {})
        },
        text: spec.prompt
      }
    }));
    pptx.defineSlideMaster({ title: master.name, background, objects: [...fixed, ...placeholders] });
  }
}

function textRuns(runs: Run[]): TextProps[] {
  return runs.map((run) => ({
    text: run.text,
    options: {
      ...(run.bullet === null ? {} : { bullet: bulletOf(run.bullet) }),
      indentLevel: run.level,
      breakLine: true
    }
  }));
}

/**
 * Copies of the deck's pictures, for pptxgenjs to read when it writes the deck. It takes a picture's content type from
 * the extension in its file name, cut short at any `?` or `#`, so each copy is named for the format its bytes are.
 */
function pictureStage() {
  const dir = mkdtempSync(join(tmpdir(), "slides-pictures-"));
  let count = 0;
  return {
    /** The copy of the picture at `path`, and its own width and height, which pptxgenjs needs to fit it without stretching it. */
    stage(path: string): { path: string; w: number; h: number } {
      let data: Buffer;
      try {
        data = readFileSync(path);
      } catch (err) {
        throw new DeckError(`cannot read the picture ${path}: ${(err as Error).message}`);
      }
      const format = formatOf(data);
      if (format === null) {
        throw new DeckError(`the picture ${path} is not a PNG, JPEG or GIF`);
      }
      let size: { width?: number; height?: number };
      try {
        size = imageSize(data);
      } catch (err) {
        throw new DeckError(`cannot read the picture ${path}: ${(err as Error).message}`);
      }
      if (!size.width || !size.height) {
        throw new DeckError(`cannot read the size of the picture ${path}`);
      }
      count += 1;
      const copy = join(dir, `picture-${count}.${EXTENSIONS[format]}`);
      writeFileSync(copy, data);
      return { path: copy, w: size.width, h: size.height };
    },
    remove(): void {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function fill(slide: Slide, box: Box, baseDir: string, stage: ReturnType<typeof pictureStage>["stage"]): void {
  if (box.placeholder === null) {
    return;
  }
  if (box.kind === "text") {
    slide.addText(textRuns(box.runs), { placeholder: box.placeholder, objectName: box.placeholder });
  } else if (box.kind === "image") {
    // `w` and `h` only give pptxgenjs the picture's proportions; `contain` fits it inside the placeholder's frame.
    const picture = stage(resolveImage(box.src, baseDir));
    slide.addImage({
      placeholder: box.placeholder,
      objectName: box.placeholder,
      path: picture.path,
      altText: box.decorative ? DECORATIVE_MARK : box.alt,
      w: box.w,
      h: (box.w * picture.h) / picture.w,
      sizing: { type: "contain", w: box.w, h: box.h }
    });
  }
}

/** A bullet list placeholder's second level, made from the first that pptxgenjs writes: the hollow bullet, one indent further in. */
function withSecondLevel(layout: string): string {
  return layout.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, (shape) => {
    const name = shape.match(/<p:cNvPr id="\d+" name="([^"]*)"/)?.[1];
    if (name === undefined || !BULLET_LISTS.has(name)) {
      return shape;
    }
    return shape.replace(/<a:lstStyle>(<a:lvl1pPr[\s\S]*?<\/a:lvl1pPr>)<\/a:lstStyle>/, (_, first: string) => {
      const second = first
        .replaceAll("a:lvl1pPr", "a:lvl2pPr")
        .replace(`marL="${emu(BULLET_INDENT)}"`, `marL="${emu(2 * BULLET_INDENT)}"`)
        .replace(`char="&#x${hex(BULLETS[0])};"`, `char="&#x${hex(BULLETS[1])};"`);
      return `<a:lstStyle>${first}${second}</a:lstStyle>`;
    });
  });
}

const literal = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Removes the blank layout pptxgenjs always adds, named DEFAULT, so no slide can be made off the brand. */
async function dropDefaultLayout(zip: JSZip): Promise<void> {
  const layouts = Object.keys(zip.files).filter((name) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name));
  for (const part of layouts) {
    if (!(await (zip.file(part) as JSZip.JSZipObject).async("string")).includes('<p:cSld name="DEFAULT"')) {
      continue;
    }
    const file = part.slice("ppt/slideLayouts/".length);
    const target = `../slideLayouts/${file}`;
    for (const rels of Object.keys(zip.files).filter((name) => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name))) {
      if ((await (zip.file(rels) as JSZip.JSZipObject).async("string")).includes(`Target="${target}"`)) {
        throw new Error(`${rels} uses the DEFAULT layout`);
      }
    }
    const masterRels = "ppt/slideMasters/_rels/slideMaster1.xml.rels";
    const rels = await (zip.file(masterRels) as JSZip.JSZipObject).async("string");
    const relationship = new RegExp(`<Relationship Id="([^"]+)" Type="[^"]+/slideLayout" Target="${literal(target)}"/>`);
    const id = rels.match(relationship)?.[1];
    if (id === undefined) {
      throw new Error(`the slide master does not name ${part}`);
    }
    zip.file(masterRels, rels.replace(relationship, ""));
    const master = "ppt/slideMasters/slideMaster1.xml";
    const masterXml = await (zip.file(master) as JSZip.JSZipObject).async("string");
    zip.file(master, masterXml.replace(new RegExp(`<p:sldLayoutId id="\\d+" r:id="${literal(id)}"/>`), ""));
    const types = "[Content_Types].xml";
    const typesXml = await (zip.file(types) as JSZip.JSZipObject).async("string");
    zip.file(types, typesXml.replace(new RegExp(`<Override PartName="/${literal(part)}" ContentType="[^"]+"/>`), ""));
    zip.remove(part);
    zip.remove(`ppt/slideLayouts/_rels/${file}.rels`);
  }
}

/**
 * What pptxgenjs cannot be told, put right in the written XML:
 * - its slide master spaces every body paragraph 20% of a line apart, and the deck spaces them by line spacing alone;
 * - it hangs a bullet as far left as its text is indented, and the deck hangs it BULLET_HANG;
 * - a layout's placeholder carries the first level's style only, so a bullet list's is given the second level's too;
 * - it adds a blank layout named DEFAULT, which is removed;
 * - decorative pictures, as above.
 */
async function finish(data: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(data);
  const rewrite = async (name: string, change: (xml: string) => string) => {
    const file = zip.file(name);
    if (file) {
      zip.file(name, change(await file.async("string")));
    }
  };
  await rewrite("ppt/slideMasters/slideMaster1.xml", (xml) =>
    xml.replace(/<p:bodyStyle>[\s\S]*?<\/p:bodyStyle>/, (style) =>
      style.replaceAll('<a:spcBef><a:spcPct val="20000"/></a:spcBef>', '<a:spcBef><a:spcPts val="0"/></a:spcBef>')
    )
  );
  await dropDefaultLayout(zip);
  const parts = Object.keys(zip.files).filter((name) => /^ppt\/(slides\/slide|slideLayouts\/slideLayout)\d+\.xml$/.test(name));
  for (const name of parts) {
    await rewrite(name, (xml) =>
      (name.startsWith("ppt/slideLayouts/") ? withSecondLevel(xml) : xml)
        .replaceAll(`indent="-${emu(BULLET_INDENT)}"`, `indent="-${emu(BULLET_HANG)}"`)
        .replaceAll(`descr="${DECORATIVE_MARK}">`, `descr="">${DECORATIVE_EXT}`)
    );
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** Builds the deck and writes it to `out`. Image paths are resolved against `baseDir`. */
export async function writeDeck(outline: Outline, baseDir: string, out: string): Promise<{ slides: number }> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "HMCTS", width: SLIDE.w, height: SLIDE.h });
  pptx.layout = "HMCTS";
  pptx.title = outline.title;
  pptx.theme = { headFontFace: "Arial", bodyFontFace: "Arial" };
  defineMasters(pptx);
  const planned = plan(outline);
  const pictures = pictureStage();
  let data: Buffer;
  try {
    for (const slidePlan of planned) {
      const slide = pptx.addSlide({ masterName: slidePlan.master });
      for (const box of slidePlan.boxes) {
        fill(slide, box, baseDir, pictures.stage);
      }
      if (slidePlan.notes) {
        slide.addNotes(slidePlan.notes);
      }
    }
    // Written here rather than with writeFile, which adds ".pptx" to a name that lacks it.
    data = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  } finally {
    pictures.remove();
  }
  const deck = await finish(data);
  try {
    writeFileSync(out, deck);
  } catch (err) {
    throw new DeckError(`cannot write ${out}: ${(err as Error).message}`);
  }
  return { slides: planned.length };
}
