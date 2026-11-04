import { type DeckOutline, type DeckSlide, deckOutline, MAX_SLIDES, newSlideId } from "@/assistant/deck";
import type { Issue, PlaceholderSpec } from "@/assistant/slides/masters";
import { masterNamed } from "@/assistant/slides/masters";

/**
 * The editor's changes to an outline, as pure functions over it, so `DeckEditor` is the screen and these are the
 * rules: bullets with one level of nesting, the slide operations, what a change of layout keeps and loses, what stops
 * a save, and the plugin's warnings placed against the fields they are about.
 */

export type Layout = DeckSlide["layout"];

/** The layouts a slide can have, in the order the masters list them, with the names the panel shows. */
export const LAYOUTS: readonly { layout: Layout; label: string }[] = [
  { layout: "HMCTS_SECTION", label: "Section" },
  { layout: "HMCTS_CONTENT", label: "Content" },
  { layout: "HMCTS_TWO_COLUMN", label: "Two columns" },
  { layout: "HMCTS_IMAGE", label: "Picture" },
  { layout: "HMCTS_CLOSING", label: "Closing" }
];

export function layoutLabel(layout: string): string {
  return LAYOUTS.find((one) => one.layout === layout)?.label ?? layout;
}

type Bullet = string | { text: string; bullets?: string[] };

/** One line of a bullet list as the editor shows it: a bullet, or one nested under the bullet before it. */
export interface EditBullet {
  text: string;
  level: 0 | 1;
}

export function flatBullets(bullets: readonly Bullet[]): EditBullet[] {
  return bullets.flatMap((one): EditBullet[] =>
    typeof one === "string"
      ? [{ text: one, level: 0 }]
      : [{ text: one.text, level: 0 }, ...(one.bullets ?? []).map((child) => ({ text: child, level: 1 as const }))]
  );
}

/** The lines back as the outline's bullets. A nested line with no bullet before it, which the editor never makes, is a bullet. */
export function nestBullets(items: readonly EditBullet[]): Bullet[] {
  const out: { text: string; bullets: string[] }[] = [];
  for (const item of items) {
    const parent = out.at(-1);
    if (item.level === 1 && parent !== undefined) {
      parent.bullets.push(item.text);
    } else {
      out.push({ text: item.text, bullets: [] });
    }
  }
  return out.map((one) => (one.bullets.length === 0 ? one.text : { text: one.text, bullets: one.bullets }));
}

/** Only one level nests, and only under a bullet, so the first line and a nested one cannot go further in. */
export const canIndent = (items: readonly EditBullet[], at: number): boolean => at > 0 && items[at]?.level === 0;
export const canOutdent = (items: readonly EditBullet[], at: number): boolean => items[at]?.level === 1;

export function setLevel(items: readonly EditBullet[], at: number, level: 0 | 1): EditBullet[] {
  return items.map((item, index) => (index === at ? { ...item, level } : item));
}

export function setText(items: readonly EditBullet[], at: number, text: string): EditBullet[] {
  return items.map((item, index) => (index === at ? { ...item, text } : item));
}

/** A new, empty line after `at`, at its level unless told another, or at the end when `at` is past the last. */
export function insertAfter(items: readonly EditBullet[], at: number, level: 0 | 1 = items[at]?.level ?? 0): EditBullet[] {
  const where = Math.min(at + 1, items.length);
  return [...items.slice(0, where), { text: "", level }, ...items.slice(where)];
}

/** Removing a bullet brings the lines nested under it out to the top level, since nothing is left for them to nest under. */
export function removeAt(items: readonly EditBullet[], at: number): EditBullet[] {
  if (items[at]?.level !== 0) {
    return items.filter((_, index) => index !== at);
  }
  const next = items.findIndex((item, index) => index > at && item.level === 0);
  const end = next === -1 ? items.length : next;
  return items.flatMap((item, index) => (index === at ? [] : index > at && index < end ? [{ ...item, level: 0 as const }] : [item]));
}

/** An id no slide of the deck has, in the form the hub gives one (`withSlideIds`). */
export function freshId(slides: readonly DeckSlide[], random: () => number = Math.random): string {
  const taken = new Set(slides.map((one) => one.id));
  let id = newSlideId(random);
  for (let tries = 0; taken.has(id); tries += 1) {
    id = tries < 16 ? newSlideId(random) : `${newSlideId(random)}${newSlideId(random).slice(2)}`;
  }
  return id;
}

export const NEW_TITLE = "New slide";
export const NEW_BULLET = "New point";

/** A slide of `layout` to start from: the words a placeholder would prompt with, so the deck still saves as it is. */
export function blankSlide(layout: Exclude<Layout, "HMCTS_IMAGE">, id: string): DeckSlide {
  switch (layout) {
    case "HMCTS_CONTENT":
      return { id, layout, title: NEW_TITLE, bullets: [NEW_BULLET] };
    case "HMCTS_TWO_COLUMN":
      return { id, layout, title: NEW_TITLE, left: [NEW_BULLET], right: [NEW_BULLET] };
    case "HMCTS_CLOSING":
      return { id, layout, title: "Questions?" };
    default:
      return { id, layout: "HMCTS_SECTION", title: NEW_TITLE };
  }
}

/** The bullets a slide holds, all of them, in reading order. */
function bulletsOf(slide: DeckSlide): Bullet[] {
  switch (slide.layout) {
    case "HMCTS_CONTENT":
      return slide.bullets;
    case "HMCTS_TWO_COLUMN":
      return [...slide.left, ...slide.right];
    default:
      return [];
  }
}

/**
 * The slide in another layout, keeping what that layout has room for: the title, notes and id always; bullets, as
 * bullets, or the first of them as a subtitle; a caption or subtitle as a bullet; a picture only on a picture slide.
 * `lost` names what does not carry over, for the editor to say before the change is made.
 */
export function changeLayout(slide: DeckSlide, layout: Layout): { slide: DeckSlide; lost: string[] } {
  const common = { ...(slide.id === undefined ? {} : { id: slide.id }), title: slide.title, ...(slide.notes === undefined ? {} : { notes: slide.notes }) };
  const bullets = bulletsOf(slide);
  const words = slide.layout === "HMCTS_IMAGE" ? slide.caption : slide.layout === "HMCTS_CLOSING" ? slide.subtitle : undefined;
  const lines: Bullet[] = bullets.length > 0 ? bullets : words === undefined ? [] : [words];
  const lost: string[] = [];
  if (slide.layout === "HMCTS_IMAGE" && layout !== "HMCTS_IMAGE") {
    lost.push("the picture");
  }
  switch (layout) {
    case "HMCTS_CONTENT":
      return { slide: { ...common, layout, bullets: lines.length > 0 ? lines : [NEW_BULLET] }, lost };
    case "HMCTS_TWO_COLUMN": {
      if (slide.layout === "HMCTS_TWO_COLUMN") {
        return { slide, lost };
      }
      const half = Math.ceil(lines.length / 2);
      const left = lines.slice(0, half);
      const right = lines.slice(half);
      return { slide: { ...common, layout, left: left.length > 0 ? left : [NEW_BULLET], right: right.length > 0 ? right : [NEW_BULLET] }, lost };
    }
    case "HMCTS_CLOSING": {
      const [first, ...rest] = lines;
      const subtitle = first === undefined ? undefined : typeof first === "string" ? first : first.text;
      if (rest.length > 0 || (first !== undefined && typeof first !== "string" && (first.bullets ?? []).length > 0)) {
        lost.push("every bullet but the first, which becomes the subtitle");
      }
      return { slide: { ...common, layout, ...(subtitle === undefined ? {} : { subtitle }) }, lost };
    }
    case "HMCTS_IMAGE":
      return { slide, lost: [] };
    default:
      if (lines.length > 0) {
        lost.push(bullets.length > 0 ? "the bullets" : slide.layout === "HMCTS_IMAGE" ? "the caption" : "the subtitle");
      }
      return { slide: { ...common, layout: "HMCTS_SECTION" }, lost };
  }
}

/** A picture cannot be chosen here, so a slide becomes a picture slide only by being one already. */
export function layoutsFor(slide: DeckSlide): readonly { layout: Layout; label: string }[] {
  return LAYOUTS.filter((one) => one.layout !== "HMCTS_IMAGE" || slide.layout === "HMCTS_IMAGE");
}

export function moveSlide(slides: readonly DeckSlide[], from: number, to: number): DeckSlide[] {
  if (from === to || to < 0 || to >= slides.length || from < 0 || from >= slides.length) {
    return [...slides];
  }
  const next = [...slides];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as DeckSlide);
  return next;
}

/** What stops the outline saving, in the person's words, against the slide it is on (0 being the title slide). */
export interface Problem {
  slide: number;
  message: string;
}

const FIELD_WORDS: Record<string, string> = {
  title: "title",
  subtitle: "subtitle",
  caption: "caption",
  notes: "speaker notes",
  bullets: "bullets",
  left: "left column",
  right: "right column",
  image: "picture"
};

/**
 * A bullet numbered the way the editor labels its line, counting nested lines in the flat list: "3", or "2, nested,"
 * for the `child`th line under the outline's `item`th bullet.
 */
function editorLine(slide: DeckSlide | undefined, field: string, item: number, child: PropertyKey | undefined): string {
  const list = ((slide as Record<string, unknown> | undefined)?.[field] ?? []) as Bullet[];
  const before = flatBullets(list.slice(0, item)).length;
  return typeof child === "number" ? `${before + child + 2}, nested,` : `${before + 1}`;
}

export const TOO_MANY_SLIDES = `A deck holds at most ${MAX_SLIDES} slides after the title slide`;

/**
 * The first thing that would stop the outline saving, said for a person: an empty title or bullet above all, which
 * are what editing makes, then anything else the hub's check refuses. `null` when it would save.
 */
export function blockingProblem(outline: DeckOutline): Problem | null {
  const parsed = deckOutline.safeParse(outline);
  if (parsed.success) {
    return null;
  }
  const [issue] = parsed.error.issues;
  const path = issue?.path ?? [];
  const onSlide = path[0] === "slides" && typeof path[1] === "number";
  const slide = onSlide ? (path[1] as number) + 1 : 0;
  const field = String(onSlide ? path[2] : path[0]);
  const item = onSlide ? path[3] : path[1];
  const line = onSlide && typeof item === "number" ? editorLine(outline.slides[path[1] as number], field, item, path[5]) : undefined;
  const where = slide === 0 ? "The title slide" : `Slide ${slide + 1}`;
  if (!onSlide && field === "slides") {
    if (issue?.code === "too_big") {
      return { slide: 0, message: TOO_MANY_SLIDES };
    }
    return { slide: 0, message: issue?.code === "too_small" ? "The deck needs at least one slide after the title slide" : `The deck: ${issue?.message}` };
  }
  if (field === "image") {
    return { slide, message: `${where}: give the picture alt text, or mark it decorative` };
  }
  const empty = issue?.message === "must be non-empty text";
  const words = FIELD_WORDS[field];
  if (empty && words !== undefined && line !== undefined) {
    return { slide, message: `${where}: ${words === "bullets" ? "bullet" : `${words} bullet`} ${line} is empty` };
  }
  if (empty && words !== undefined) {
    return { slide, message: `${where}: the ${words} is empty` };
  }
  return { slide, message: `${where}: ${words === undefined ? "" : `the ${words} `}${issue?.message ?? "is not valid"}` };
}

/** One of the plugin's warnings against the field it is about: `item` for one bullet, from 0, across the whole list. */
export interface FieldWarning {
  field: string;
  item?: number;
  message: string;
}

const WHERE_RE = /^(?:outline|slides\[(\d+)\])\.(\w+)(?: item (\d+))?$/;

/**
 * The plugin's own warnings (`lint` in `slides/masters.ts`, run once over the whole deck) for the slide at `slide`,
 * 0 being the title slide, so the editor shows the same words over a limit that `slides build` prints. They never
 * stop a save.
 */
export function slideWarnings(issues: readonly Issue[], slide: number): FieldWarning[] {
  return issues.flatMap((issue: Issue) => {
    const match = WHERE_RE.exec(issue.where);
    if (match === null) {
      return [];
    }
    const at = match[1] === undefined ? 0 : Number(match[1]) + 1;
    if (at !== slide) {
      return [];
    }
    const field = match[2] as string;
    return [{ field, ...(match[3] === undefined ? {} : { item: Number(match[3]) - 1 }), message: issue.message }];
  });
}

/** The limits of the placeholder a field fills, as the hint under it says them. */
export function fieldHint(layout: string, field: string): string | undefined {
  const spec: PlaceholderSpec | undefined = masterNamed(layout)?.placeholders.find((one) => one.field === field);
  if (spec === undefined) {
    return undefined;
  }
  const parts: string[] = [];
  if (spec.kind === "bullets") {
    if (spec.maxItems !== undefined) {
      parts.push(`up to ${spec.maxItems} bullets, nested ones included`);
    }
    if (spec.maxWords !== undefined) {
      parts.push(`${spec.maxWords} words each`);
    }
  } else if (spec.maxChars !== undefined) {
    parts.push(`about ${spec.maxChars} characters, on one line`);
  } else if (spec.maxWords !== undefined) {
    parts.push(`up to ${spec.maxWords} words`);
  }
  if (parts.length === 0) {
    return undefined;
  }
  const said = parts.join(", ");
  return `Fits ${said}.`;
}
