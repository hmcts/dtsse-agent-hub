/**
 * Writes a deck with pptxgenjs from `masters.ts`: each master becomes a slide layout of the deck's slide master, and
 * each planned box goes into its placeholder. Every position comes from `masters.ts`; this file only converts units
 * and fills placeholders, so the deck stays editable and on-brand in PowerPoint.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { imageSize } from "image-size";
import JSZip from "jszip";
import { type Box, BULLET_HANG, BULLET_INDENT, MASTERS, type Outline, type PlaceholderSpec, plan, type Run, SLIDE, type TextStyle } from "./masters.ts";
import { resolveImage } from "./outline.ts";
import { PptxGenJS, type Pres, type Slide, type TextProps } from "./pptx.ts";

const ASSETS = new URL("./assets/", import.meta.url);

/** pptxgenjs takes positions in inches but insets and indents in points. */
const points = (inches: number): number => inches * 72;

/** Inches as the EMU the deck's XML is written in. */
const emu = (inches: number): number => Math.round(inches * 914400);

/**
 * pptxgenjs has no way to mark a picture decorative and writes its file path as the description of a picture
 * without alt text, so a decorative picture is given this marker, replaced once the deck is written.
 */
const DECORATIVE_MARK = "slides-decorative-picture";
const DECORATIVE_EXT =
  '<a:extLst><a:ext uri="{C183D7F6-B498-43B3-948B-1728B52AA6E4}"><adec:decorative xmlns:adec="http://schemas.microsoft.com/office/drawing/2017/decorative" val="1"/></a:ext></a:extLst>';

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
          ...(spec.style ? textOptions(spec.style) : {})
        },
        text: spec.prompt
      }
    }));
    pptx.defineSlideMaster({ title: master.name, background, objects: [...fixed, ...placeholders] });
  }
}

const hex = (char: string): string => (char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");

function textRuns(runs: Run[]): TextProps[] {
  return runs.map((run) => ({
    text: run.text,
    options: {
      ...(run.bullet === null ? {} : { bullet: { characterCode: hex(run.bullet), indent: points(BULLET_INDENT) } }),
      indentLevel: run.level,
      breakLine: true
    }
  }));
}

/** A picture's own width and height, which pptxgenjs needs to fit it inside its placeholder without stretching it. */
function pixelSize(path: string): { w: number; h: number } {
  const size = imageSize(readFileSync(path));
  if (!size.width || !size.height) {
    throw new Error(`cannot read the size of ${path}`);
  }
  return { w: size.width, h: size.height };
}

function fill(slide: Slide, box: Box, baseDir: string): void {
  if (box.placeholder === null) {
    return;
  }
  if (box.kind === "text") {
    slide.addText(textRuns(box.runs), { placeholder: box.placeholder, objectName: box.placeholder });
  } else if (box.kind === "image") {
    // `w` and `h` only give pptxgenjs the picture's proportions; `contain` fits it inside the placeholder's frame.
    const path = resolveImage(box.src, baseDir);
    const px = pixelSize(path);
    slide.addImage({
      placeholder: box.placeholder,
      objectName: box.placeholder,
      path,
      altText: box.decorative ? DECORATIVE_MARK : box.alt,
      w: box.w,
      h: (box.w * px.h) / px.w,
      sizing: { type: "contain", w: box.w, h: box.h }
    });
  }
}

/**
 * What pptxgenjs cannot be told, put right in the written XML:
 * - its slide master spaces every body paragraph 20% of a line apart, and the deck spaces them by line spacing alone;
 * - it hangs a bullet as far left as its text is indented, and the deck hangs it BULLET_HANG;
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
  const parts = Object.keys(zip.files).filter((name) => /^ppt\/(slides\/slide|slideLayouts\/slideLayout)\d+\.xml$/.test(name));
  for (const name of parts) {
    await rewrite(name, (xml) =>
      xml.replaceAll(`indent="-${emu(BULLET_INDENT)}"`, `indent="-${emu(BULLET_HANG)}"`).replaceAll(`descr="${DECORATIVE_MARK}">`, `descr="">${DECORATIVE_EXT}`)
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
  for (const slidePlan of planned) {
    const slide = pptx.addSlide({ masterName: slidePlan.master });
    for (const box of slidePlan.boxes) {
      fill(slide, box, baseDir);
    }
    if (slidePlan.notes) {
      slide.addNotes(slidePlan.notes);
    }
  }
  // Written here rather than with writeFile, which adds ".pptx" to a name that lacks it.
  const data = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  writeFileSync(out, await finish(data));
  return { slides: planned.length };
}
