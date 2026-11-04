/**
 * The HMCTS masters and everything about where things go on a slide: size, colours, type, each master's fixed
 * elements and placeholders, their limits, and `plan`, which lays an outline out as boxes. Measurements are inches
 * on the deck's own 10 × 5.625in slide; comments give the source deck's EMU where a value is copied from it.
 *
 * This file imports nothing, and nothing in it knows about PowerPoint, so the same file can be the geometry of a
 * browser preview: the pptxgenjs builder only turns these boxes into shapes.
 */

export const SLIDE = { w: 10, h: 5.625 } as const;

export const COLOURS = {
  navy: "073763",
  white: "FFFFFF",
  black: "000000",
  /** The deck theme's dk2: 7:1 on white, enough for the small caption text it is used for. */
  grey: "595959"
} as const;

export const FONT = "Arial";

export const FONT_SIZES = { coverTitle: 50, coverSubtitle: 15, sectionTitle: 40, barTitle: 24, body: 18, caption: 14 } as const;

/** The title and closing slides' artwork: crest, "HM Courts & Tribunals Service" and the skyline, full bleed. */
export const BACKGROUND_IMAGE = "hmcts-title-background.png";

/** The deck's inset on every text box: 91425 EMU. */
export const INSET = 0.1;

/** The deck's bullets: a filled disc, then a hollow one for the level below. */
export const BULLETS = ["●", "○"] as const;
/** How far each bullet level's text starts from the box's inset edge, which is where the deck's starts. */
export const BULLET_INDENT = 0.5;
/** How far a bullet hangs left of its text: the deck's 342900 EMU. */
export const BULLET_HANG = 0.375;

/** A line of single-spaced Arial, as PowerPoint and LibreOffice set it, in multiples of the font size. */
export const LINE_HEIGHT = 1.2;

/** Arial's advance widths in thousandths of an em, for estimating how text wraps. */
const ARIAL_WIDTHS: Record<string, number> = {
  " ": 278,
  "!": 278,
  '"': 355,
  "#": 556,
  $: 556,
  "%": 889,
  "&": 667,
  "'": 191,
  "(": 333,
  ")": 333,
  "*": 389,
  "+": 584,
  ",": 278,
  "-": 333,
  ".": 278,
  "/": 278,
  ":": 278,
  ";": 278,
  "<": 584,
  "=": 584,
  ">": 584,
  "?": 556,
  "@": 1015,
  "[": 278,
  "\\": 278,
  "]": 278,
  "^": 469,
  _: 556,
  "`": 333,
  "{": 334,
  "|": 260,
  "}": 334,
  "~": 584,
  A: 667,
  B: 667,
  C: 722,
  D: 722,
  E: 667,
  F: 611,
  G: 778,
  H: 722,
  I: 278,
  J: 500,
  K: 667,
  L: 556,
  M: 833,
  N: 722,
  O: 778,
  P: 667,
  Q: 778,
  R: 722,
  S: 667,
  T: 611,
  U: 722,
  V: 667,
  W: 944,
  X: 667,
  Y: 667,
  Z: 611,
  c: 500,
  f: 278,
  i: 222,
  j: 222,
  k: 500,
  l: 222,
  m: 833,
  r: 333,
  s: 500,
  t: 278,
  v: 500,
  w: 722,
  x: 500,
  y: 500,
  z: 500,
  "‘": 222,
  "’": 222,
  "“": 333,
  "”": 333,
  "–": 556,
  "—": 1000,
  "…": 1000
};
/** Every other lowercase letter and digit is this wide, and so, for an estimate, is any other Latin character. */
const ARIAL_COMMON = 556;
/** Symbols, emoji and East Asian characters are about an em wide. */
const ARIAL_WIDE = 1000;

const advance = (char: string): number => ARIAL_WIDTHS[char] ?? ((char.codePointAt(0) ?? 0) < 0x2000 ? ARIAL_COMMON : ARIAL_WIDE);

/** How wide `text` is in Arial at `fontSize`, in points. */
export function textWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const char of text) {
    width += advance(char);
  }
  return (width * fontSize) / 1000;
}

/** How many lines `text` wraps to in a line `width` points long: whole words, and a word too long for a line broken anywhere. */
export function wrappedLines(text: string, width: number, fontSize: number): number {
  const space = textWidth(" ", fontSize);
  let lines = 1;
  let used = 0;
  let empty = true;
  for (const word of text.split(/\s+/).filter((part) => part !== "")) {
    const w = textWidth(word, fontSize);
    if (!empty && used + space + w <= width) {
      used += space + w;
      continue;
    }
    if (!empty) {
      lines += 1;
      used = 0;
    }
    empty = false;
    if (w <= width) {
      used = w;
      continue;
    }
    for (const char of word) {
      const c = textWidth(char, fontSize);
      if (used > 0 && used + c > width) {
        lines += 1;
        used = 0;
      }
      used += c;
    }
  }
  return lines;
}

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextStyle {
  fontFace: string;
  fontSize: number;
  color: string;
  align: "left";
  valign: "top" | "middle";
  inset: number;
  lineSpacingMultiple?: number;
  /** Points after each paragraph. */
  paraSpaceAfter?: number;
}

export interface Run {
  text: string;
  /** 0 for a bullet or a plain line, 1 for a bullet nested under one. */
  level: 0 | 1;
  bullet: string | null;
}

export type Box =
  | (Frame & { kind: "text"; style: TextStyle; runs: Run[]; decorative: false; placeholder: string | null })
  | (Frame & { kind: "rect"; style: { fill: string }; decorative: true; placeholder: null })
  | (Frame & { kind: "image"; style: { fit: "contain" }; src: string; alt: string; decorative: boolean; placeholder: string });

export type FieldKind = "text" | "bullets" | "image";

export interface PlaceholderSpec extends Frame {
  /** The placeholder's name in the deck, which a slide's content goes into. */
  name: string;
  /** The outline field that fills it. */
  field: string;
  kind: FieldKind;
  required: boolean;
  description: string;
  /** What PowerPoint shows in the empty placeholder. */
  prompt: string;
  /** Text styles; a picture placeholder has none. */
  style?: TextStyle;
  /** For text, the most words; for bullets, the most words in any one item. */
  maxWords?: number;
  /** For text, the most characters that are sure to fit in `maxLines`. */
  maxChars?: number;
  /** For text, the most lines it may wrap to; for bullets, the most lines any one item may wrap to. */
  maxLines?: number;
  /** For bullets, the most items, nested ones included. */
  maxItems?: number;
}

export interface MasterSpec {
  name: string;
  description: string;
  /** Whether it may be a slide's layout; the title slide is made from the outline's own title and subtitle. */
  inSlides: boolean;
  background: { color: string } | { image: string };
  /** Drawn on every slide of the master and not editable from the slide. */
  fixed: Box[];
  /** In reading order. */
  placeholders: PlaceholderSpec[];
}

/** The navy bar across the top of every content slide: 1060500 EMU deep. */
const BAR: Box = { kind: "rect", x: 0, y: 0, w: SLIDE.w, h: 1.1598, style: { fill: COLOURS.navy }, decorative: true, placeholder: null };
/** The white title on the bar: off 224725,201900, ext 7893900x844200 EMU. */
const BAR_TITLE: Frame = { x: 0.2458, y: 0.2208, w: 8.633, h: 0.9232 };
/** The body under the bar: off 224725,1349800, ext 8514000x3122700 EMU. */
const BODY: Frame = { x: 0.2458, y: 1.4762, w: 9.311, h: 3.4151 };
const GUTTER = 0.15;
const COLUMN_W = (BODY.w - GUTTER) / 2;
/** Title slide title: off 311700,1102175, ext 8520600x990600 EMU. */
const COVER_TITLE: Frame = { x: 0.3409, y: 1.2054, w: 9.3183, h: 1.0833 };
/** Title slide subtitle: off 353850,1905575, ext 8520600x792600 EMU. */
const COVER_SUBTITLE: Frame = { x: 0.387, y: 2.084, w: 9.3183, h: 0.8668 };
/** The deck's pictures sit between 1.18in and 5.49in down; this leaves room for a caption under one. */
const PICTURE: Frame = { x: 0.2458, y: 1.3, w: 9.511, h: 3.45 };
const CAPTION: Frame = { x: 0.2458, y: 4.8, w: 9.511, h: 0.6 };

const text = (fontSize: number, color: string, valign: TextStyle["valign"], more: Partial<TextStyle> = {}): TextStyle => ({
  fontFace: FONT,
  fontSize,
  color,
  align: "left",
  valign,
  inset: INSET,
  ...more
});

/** Body text: 18pt, as on most of the deck's text slides, black, at the deck's 150% line spacing. */
const BODY_STYLE = text(FONT_SIZES.body, COLOURS.black, "top", { lineSpacingMultiple: 1.5 });

const barTitle = (maxWords = 8): PlaceholderSpec => ({
  ...BAR_TITLE,
  name: "title",
  field: "title",
  kind: "text",
  required: true,
  description: "Slide title",
  prompt: "Slide title",
  style: text(FONT_SIZES.barTitle, COLOURS.white, "top"),
  maxWords
});

/**
 * The title on the artwork is one line, as in the deck: a second would run into the subtitle and the skyline's cloud.
 * 23 characters as wide as most lowercase letters fill the line at 50pt.
 */
const coverTitle = (description: string, prompt: string): PlaceholderSpec => ({
  ...COVER_TITLE,
  name: "title",
  field: "title",
  kind: "text",
  required: true,
  description,
  prompt,
  style: text(FONT_SIZES.coverTitle, COLOURS.white, "middle"),
  maxChars: 23,
  maxLines: 1
});

const coverSubtitle = (description: string, prompt: string, maxWords: number, h = COVER_SUBTITLE.h): PlaceholderSpec => ({
  ...COVER_SUBTITLE,
  h,
  name: "subtitle",
  field: "subtitle",
  kind: "text",
  required: false,
  description,
  prompt,
  style: text(FONT_SIZES.coverSubtitle, COLOURS.white, "top", { paraSpaceAfter: 12 }),
  maxWords
});

/**
 * Limits for a list of bullets that fit its box at worst: `maxItems` items of `maxWords` seven-character words, each
 * character as wide as most lowercase letters, wrap to no more than `maxLines` lines each, and that many lines fit.
 */
const bullets = (name: string, frame: Frame, description: string, maxWords: number, maxLines: number, maxItems: number): PlaceholderSpec => ({
  ...frame,
  name,
  field: name === "body" ? "bullets" : name,
  kind: "bullets",
  required: true,
  description,
  prompt: "Bullet points",
  style: BODY_STYLE,
  maxWords,
  maxLines,
  maxItems
});

export const MASTERS: readonly MasterSpec[] = [
  {
    name: "HMCTS_TITLE",
    description: "Opening slide on the HMCTS artwork. Made from the outline's top-level title, subtitle and notes; not a slide layout.",
    inSlides: false,
    background: { image: BACKGROUND_IMAGE },
    fixed: [],
    placeholders: [coverTitle("Deck title", "Presentation title"), coverSubtitle("One line saying what the talk is", "What the talk is about", 15)]
  },
  {
    name: "HMCTS_SECTION",
    description: "Navy divider that starts a new part of the talk.",
    inSlides: true,
    background: { color: COLOURS.navy },
    fixed: [],
    placeholders: [
      {
        x: COVER_TITLE.x,
        y: 2.1,
        w: COVER_TITLE.w,
        h: 1.4,
        name: "title",
        field: "title",
        kind: "text",
        required: true,
        description: "Section name",
        prompt: "Section title",
        style: text(FONT_SIZES.sectionTitle, COLOURS.white, "middle"),
        maxWords: 6
      }
    ]
  },
  {
    name: "HMCTS_CONTENT",
    description: "Title bar and a bulleted list. One idea per slide.",
    inSlides: true,
    background: { color: COLOURS.white },
    fixed: [BAR],
    placeholders: [barTitle(), bullets("body", BODY, "Strings, or {text, bullets: [strings]} for one nested level", 7, 1, 6)]
  },
  {
    name: "HMCTS_TWO_COLUMN",
    description: "Title bar and two bulleted columns, for a comparison or a before and after.",
    inSlides: true,
    background: { color: COLOURS.white },
    fixed: [BAR],
    placeholders: [
      barTitle(),
      bullets("left", { ...BODY, w: COLUMN_W }, "Left column, bullets as for HMCTS_CONTENT", 6, 2, 3),
      bullets("right", { ...BODY, x: BODY.x + COLUMN_W + GUTTER, w: COLUMN_W }, "Right column, bullets as for HMCTS_CONTENT", 6, 2, 3)
    ]
  },
  {
    name: "HMCTS_IMAGE",
    description: "Title bar and one picture, scaled to fit without cropping, with an optional caption.",
    inSlides: true,
    background: { color: COLOURS.white },
    fixed: [BAR],
    placeholders: [
      barTitle(),
      {
        ...PICTURE,
        name: "image",
        field: "image",
        kind: "image",
        required: true,
        description:
          "{path, alt} or {path, decorative: true}: a PNG, JPEG or GIF relative to the outline file. alt says what the picture shows; decorative is only for a picture that adds nothing",
        prompt: "Picture"
      },
      {
        ...CAPTION,
        name: "caption",
        field: "caption",
        kind: "text",
        required: false,
        description: "One line under the picture",
        prompt: "Caption",
        style: text(FONT_SIZES.caption, COLOURS.grey, "top"),
        maxWords: 20
      }
    ]
  },
  {
    name: "HMCTS_CLOSING",
    description: "Last slide on the HMCTS artwork: thanks, questions, or where to find out more.",
    inSlides: true,
    background: { image: BACKGROUND_IMAGE },
    fixed: [],
    placeholders: [coverTitle('Closing line, such as "Questions?"', "Questions?"), coverSubtitle("Contact or follow-up details", "Contact details", 25, 1.4)]
  }
];

export function masterNamed(name: string): MasterSpec | undefined {
  return MASTERS.find((master) => master.name === name);
}

export type Bullet = string | { text: string; bullets?: string[] };

export type ImageRef = { path: string; alt: string; decorative?: false } | { path: string; decorative: true; alt?: string };

export interface OutlineSlide {
  /** The caller's own handle for the slide, kept through `plan` so it survives reordering. Never shown. */
  id?: string;
  layout: string;
  title: string;
  subtitle?: string;
  bullets?: Bullet[];
  left?: Bullet[];
  right?: Bullet[];
  image?: ImageRef;
  caption?: string;
  notes?: string;
}

export interface Outline {
  title: string;
  subtitle?: string;
  /** Speaker notes for the title slide. */
  notes?: string;
  slides: OutlineSlide[];
}

export interface PlannedSlide {
  id?: string;
  master: string;
  background: MasterSpec["background"];
  /** In reading order. The master's fixed, decorative boxes come first, so they also draw underneath. */
  boxes: Box[];
  notes?: string;
}

export function runsOf(value: Bullet[]): Run[] {
  return value.flatMap((bullet): Run[] =>
    typeof bullet === "string"
      ? [{ text: bullet, level: 0, bullet: BULLETS[0] }]
      : [{ text: bullet.text, level: 0, bullet: BULLETS[0] }, ...(bullet.bullets ?? []).map((sub): Run => ({ text: sub, level: 1, bullet: BULLETS[1] }))]
  );
}

function boxFor(spec: PlaceholderSpec, value: unknown): Box {
  const frame = { x: spec.x, y: spec.y, w: spec.w, h: spec.h };
  if (spec.kind === "image") {
    const image = value as ImageRef;
    const decorative = image.decorative === true;
    return {
      ...frame,
      kind: "image",
      style: { fit: "contain" },
      src: image.path,
      alt: decorative ? "" : (image.alt ?? ""),
      decorative,
      placeholder: spec.name
    };
  }
  const runs = spec.kind === "bullets" ? runsOf(value as Bullet[]) : [{ text: value as string, level: 0 as const, bullet: null }];
  return { ...frame, kind: "text", style: spec.style as TextStyle, runs, decorative: false, placeholder: spec.name };
}

function planSlide(master: MasterSpec, content: Record<string, unknown>, id: string | undefined, notes: string | undefined): PlannedSlide {
  const filled = master.placeholders.filter((spec) => content[spec.field] !== undefined).map((spec) => boxFor(spec, content[spec.field]));
  return {
    ...(id === undefined ? {} : { id }),
    master: master.name,
    background: master.background,
    boxes: [...master.fixed.map((box) => ({ ...box })), ...filled],
    ...(notes === undefined ? {} : { notes })
  };
}

/** The slides an outline makes, the title slide first. Expects an outline with no structural errors. */
export function plan(outline: Outline): PlannedSlide[] {
  const cover = masterNamed("HMCTS_TITLE") as MasterSpec;
  return [
    planSlide(cover, { title: outline.title, subtitle: outline.subtitle }, undefined, outline.notes),
    ...outline.slides.map((slide) => {
      const master = masterNamed(slide.layout);
      if (master === undefined || !master.inSlides) {
        throw new Error(`${slide.layout} is not a slide layout`);
      }
      return planSlide(master, slide as unknown as Record<string, unknown>, slide.id, slide.notes);
    })
  ];
}

export interface Issue {
  level: "error" | "warning";
  where: string;
  message: string;
}

export function wordCount(value: string): number {
  return value.split(/\s+/).filter((word) => word !== "").length;
}

/** How long a line of a placeholder's text is, in points: inside its insets and, for a bullet, after its indent. */
function lineWidth(spec: PlaceholderSpec, level: number | null): number {
  const style = spec.style as TextStyle;
  const indent = level === null ? 0 : BULLET_INDENT * (level + 1);
  return (spec.w - 2 * style.inset - indent) * 72;
}

/** How many lines `text` wraps to in a placeholder, as a bullet at `level` or, with null, as plain text. */
export function linesIn(spec: PlaceholderSpec, text: string, level: number | null): number {
  return wrappedLines(text, lineWidth(spec, level), (spec.style as TextStyle).fontSize);
}

/** How many lines of a placeholder's text fit inside its insets. */
export function linesThatFit(spec: PlaceholderSpec): number {
  const style = spec.style as TextStyle;
  const line = style.fontSize * LINE_HEIGHT * (style.lineSpacingMultiple ?? 1);
  return Math.floor(((spec.h - 2 * style.inset) * 72) / line + 1e-9);
}

const linesSaid = (n: number): string => (n === 1 ? "1 line" : `${n} lines`);

function lintField(where: string, spec: PlaceholderSpec, value: unknown, issues: Issue[]): void {
  if (spec.kind === "text" && typeof value === "string") {
    if (spec.maxWords !== undefined && wordCount(value) > spec.maxWords) {
      issues.push({ level: "warning", where, message: `has ${wordCount(value)} words; the placeholder fits ${spec.maxWords}` });
    } else if (spec.maxLines !== undefined && linesIn(spec, value, null) > spec.maxLines) {
      const chars = spec.maxChars === undefined ? "" : `, about ${spec.maxChars} characters`;
      issues.push({
        level: "warning",
        where,
        message: `runs to about ${linesSaid(linesIn(spec, value, null))}; the placeholder fits ${linesSaid(spec.maxLines)}${chars}`
      });
    }
  } else if (spec.kind === "bullets" && Array.isArray(value)) {
    const runs = runsOf(value as Bullet[]);
    let lines = 0;
    for (const [i, run] of runs.entries()) {
      const runLines = linesIn(spec, run.text, run.level);
      lines += runLines;
      if (spec.maxWords !== undefined && wordCount(run.text) > spec.maxWords) {
        issues.push({ level: "warning", where: `${where} item ${i + 1}`, message: `has ${wordCount(run.text)} words; keep a bullet to ${spec.maxWords}` });
      } else if (spec.maxLines !== undefined && runLines > spec.maxLines) {
        issues.push({
          level: "warning",
          where: `${where} item ${i + 1}`,
          message: `runs to about ${linesSaid(runLines)}; keep a bullet to ${linesSaid(spec.maxLines)}`
        });
      }
    }
    if (spec.maxItems !== undefined && runs.length > spec.maxItems) {
      issues.push({
        level: "warning",
        where,
        message: `has ${runs.length} bullets, nested ones included; the placeholder fits ${spec.maxItems}. Split the slide`
      });
    } else if (lines > linesThatFit(spec)) {
      issues.push({
        level: "warning",
        where,
        message: `runs to about ${linesSaid(lines)}; the placeholder fits ${linesSaid(linesThatFit(spec))}. Split the slide`
      });
    }
  } else if (spec.kind === "image" && typeof value === "object" && value !== null) {
    const image = value as { alt?: unknown; decorative?: unknown };
    if (image.decorative === true && typeof image.alt === "string" && image.alt.trim() !== "") {
      issues.push({ level: "warning", where, message: "is marked decorative, so its alt text is not used" });
    }
  }
}

/**
 * Text over a placeholder's limits, its wrapped lines estimated from Arial's widths; a decorative picture given alt
 * text; and two slides with one title, all as warnings. A picture with neither alt text nor `decorative` is refused by
 * the outline's structural check.
 */
export function lint(outline: Outline): Issue[] {
  const issues: Issue[] = [];
  const check = (where: string, master: MasterSpec, content: Record<string, unknown>) => {
    for (const spec of master.placeholders) {
      if (content[spec.field] !== undefined) {
        lintField(`${where}.${spec.field}`, spec, content[spec.field], issues);
      }
    }
  };
  check("outline", masterNamed("HMCTS_TITLE") as MasterSpec, { title: outline.title, subtitle: outline.subtitle });
  // Screen reader users move through a deck by slide title, so two slides with one title read as one.
  const titles = new Map<string, number>();
  outline.slides.forEach((slide, i) => {
    const master = masterNamed(slide.layout);
    if (master !== undefined) {
      check(`slides[${i}]`, master, slide as unknown as Record<string, unknown>);
    }
    const key = typeof slide.title === "string" ? slide.title.trim().toLowerCase() : "";
    const first = titles.get(key);
    if (first === undefined) {
      titles.set(key, i);
    } else if (key !== "") {
      issues.push({ level: "warning", where: `slides[${i}].title`, message: `is the same as slides[${first}]'s; give each slide its own title` });
    }
  });
  return issues;
}

/** What `slides layouts` prints: each master's fields and limits, for the skill to read at run time. */
export function layoutSummary(): unknown[] {
  return MASTERS.map((master) => ({
    name: master.name,
    description: master.description,
    usableInSlides: master.inSlides,
    fields: Object.fromEntries(
      master.placeholders.map((spec) => [
        spec.field,
        {
          kind: spec.kind,
          required: spec.required,
          description: spec.description,
          ...(spec.maxWords === undefined ? {} : { maxWords: spec.maxWords }),
          ...(spec.maxChars === undefined ? {} : { maxChars: spec.maxChars }),
          ...(spec.maxLines === undefined ? {} : { maxLines: spec.maxLines }),
          ...(spec.maxItems === undefined ? {} : { maxItems: spec.maxItems })
        }
      ])
    )
  }));
}
