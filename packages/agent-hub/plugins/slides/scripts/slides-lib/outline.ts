/**
 * Checks an outline read from a file: its shape, its layouts and fields, that its images exist, and then `lint`'s
 * limits and alt text. Errors stop the build; text over a limit is only a warning, since the slide still renders.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { lint, MASTERS, type MasterSpec, masterNamed, type Outline, type OutlineSlide } from "./masters.ts";

export interface Checked {
  errors: string[];
  warnings: string[];
}

/** An outline that cannot be built: every problem found, so they can all be fixed at once. */
export class OutlineError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`the outline has ${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.problems = problems;
  }
}

/** The format each picture extension names. */
const IMAGE_TYPES = new Map([
  [".png", "PNG"],
  [".jpg", "JPEG"],
  [".jpeg", "JPEG"],
  [".gif", "GIF"]
]);
/** The bytes a file of each format starts with. */
const SIGNATURES: [string, Buffer[]][] = [
  ["PNG", [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]],
  ["JPEG", [Buffer.from([0xff, 0xd8, 0xff])]],
  ["GIF", [Buffer.from("GIF87a", "ascii"), Buffer.from("GIF89a", "ascii")]]
];
/** Keys a `{text, bullets}` bullet may have. */
const BULLET_KEYS = new Set(["text", "bullets"]);
/** Keys every slide may have whatever its layout. */
const COMMON = new Set(["id", "layout", "notes"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const nonEmpty = (value: unknown): boolean => typeof value === "string" && value.trim() !== "";

/** Image paths are relative to the outline file, so an outline and its pictures can move together. */
export function resolveImage(path: string, baseDir: string): string {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

function checkBullets(where: string, value: unknown, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${where} must be a non-empty list of bullets`);
    return;
  }
  value.forEach((bullet, i) => {
    const at = `${where}[${i}]`;
    if (!isRecord(bullet)) {
      if (!nonEmpty(bullet)) {
        errors.push(`${at} must be non-empty text, or {text, bullets}`);
      }
      return;
    }
    if (!nonEmpty(bullet.text)) {
      errors.push(`${at}.text must be non-empty text`);
    }
    for (const key of Object.keys(bullet)) {
      if (!BULLET_KEYS.has(key)) {
        errors.push(`${at}.${key} is not a field of a bullet, which takes text, bullets`);
      }
    }
    if (bullet.bullets === undefined) {
      return;
    }
    if (!Array.isArray(bullet.bullets)) {
      errors.push(`${at}.bullets must be a list of text`);
      return;
    }
    bullet.bullets.forEach((sub, j) => {
      if (typeof sub === "object" && sub !== null) {
        errors.push(`${at}.bullets[${j}] nests too deep: bullets go one level down at most`);
      } else if (!nonEmpty(sub)) {
        errors.push(`${at}.bullets[${j}] must be non-empty text`);
      }
    });
  });
}

/** Which picture format a file's first bytes are, or null when they are none of them. */
function sniff(file: string): string | null {
  const head = Buffer.alloc(8);
  const fd = openSync(file, "r");
  let length: number;
  try {
    length = readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  const start = head.subarray(0, length);
  const match = SIGNATURES.find(([, signatures]) => signatures.some((signature) => start.subarray(0, signature.length).equals(signature)));
  return match ? match[0] : null;
}

function checkImage(where: string, value: unknown, baseDir: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${where} must be {path, alt} or {path, decorative: true}`);
    return;
  }
  if (value.alt !== undefined && typeof value.alt !== "string") {
    errors.push(`${where}.alt must be text`);
  }
  if (value.decorative !== undefined && typeof value.decorative !== "boolean") {
    errors.push(`${where}.decorative must be true or false`);
  }
  if (!nonEmpty(value.path)) {
    errors.push(`${where}.path is missing`);
    return;
  }
  const file = resolveImage(value.path as string, baseDir);
  if (!existsSync(file) || !statSync(file).isFile()) {
    errors.push(`${where}.path ${value.path} does not exist (looked for ${file})`);
    return;
  }
  const named = IMAGE_TYPES.get(extname(file).toLowerCase());
  if (named === undefined) {
    errors.push(`${where}.path ${value.path} is not a PNG, JPEG or GIF`);
    return;
  }
  let holds: string | null;
  try {
    holds = sniff(file);
  } catch (err) {
    errors.push(`${where}.path ${value.path} cannot be read: ${(err as Error).message}`);
    return;
  }
  // The deck gives a picture the content type its extension names, and PowerPoint cannot show one whose bytes disagree.
  if (holds === null) {
    errors.push(`${where}.path ${value.path} is named as a ${named} but is not a PNG, JPEG or GIF`);
  } else if (holds !== named) {
    errors.push(`${where}.path ${value.path} is named as a ${named} but is a ${holds}`);
  }
}

function checkFields(where: string, content: Record<string, unknown>, master: MasterSpec, baseDir: string, errors: string[]): void {
  for (const spec of master.placeholders) {
    const value = content[spec.field];
    const at = `${where}.${spec.field}`;
    if (value === undefined) {
      if (spec.required) {
        errors.push(`${at} is required by ${master.name}`);
      }
    } else if (spec.kind === "text") {
      if (!nonEmpty(value)) {
        errors.push(`${at} must be non-empty text`);
      }
    } else if (spec.kind === "bullets") {
      checkBullets(at, value, errors);
    } else {
      checkImage(at, value, baseDir, errors);
    }
  }
  const fields = master.placeholders.map((spec) => spec.field);
  for (const key of Object.keys(content)) {
    if (!COMMON.has(key) && !fields.includes(key)) {
      errors.push(`${where}.${key} is not a field of ${master.name}, which takes ${fields.join(", ")}`);
    }
  }
  if (content.notes !== undefined && typeof content.notes !== "string") {
    errors.push(`${where}.notes must be text`);
  }
}

/**
 * The structural errors, and the parts of the outline that had none, for `lint` to check too. `passed.slides` is
 * sparse, each slide that passed at its own index, so lint names it by its place in the outline and skips the others.
 */
function checkStructure(input: unknown, baseDir: string): { errors: string[]; passed: Outline } {
  const errors: string[] = [];
  const passed = { slides: [] as OutlineSlide[] } as Outline;
  if (!isRecord(input)) {
    return { errors: ["the outline must be a JSON object with title and slides"], passed };
  }
  const { slides, ...top } = input;
  if (top.id !== undefined || top.layout !== undefined) {
    errors.push("outline takes title, subtitle, notes and slides; id and layout belong on a slide");
  }
  const before = errors.length;
  checkFields("outline", top, masterNamed("HMCTS_TITLE") as MasterSpec, baseDir, errors);
  if (errors.length === before) {
    Object.assign(passed, { title: top.title, subtitle: top.subtitle });
  }
  if (!Array.isArray(slides) || slides.length === 0) {
    errors.push("outline.slides must be a non-empty list");
    return { errors, passed };
  }
  const usable = MASTERS.filter((master) => master.inSlides).map((master) => master.name);
  const ids = new Map<string, number>();
  slides.forEach((slide, i) => {
    const where = `slides[${i}]`;
    if (!isRecord(slide)) {
      errors.push(`${where} must be an object`);
      return;
    }
    if (slide.id !== undefined) {
      if (!nonEmpty(slide.id)) {
        errors.push(`${where}.id must be non-empty text`);
      } else if (ids.has(slide.id as string)) {
        errors.push(`${where}.id ${JSON.stringify(slide.id)} is already slides[${ids.get(slide.id as string)}]'s`);
      } else {
        ids.set(slide.id as string, i);
      }
    }
    const master = typeof slide.layout === "string" ? masterNamed(slide.layout) : undefined;
    if (master === undefined || !master.inSlides) {
      const why = slide.layout === "HMCTS_TITLE" ? "the title slide is made from the outline's own title and subtitle" : `use one of ${usable.join(", ")}`;
      errors.push(`${where}.layout ${JSON.stringify(slide.layout ?? null)} is not a layout: ${why}`);
      return;
    }
    const count = errors.length;
    checkFields(where, slide, master, baseDir, errors);
    if (errors.length === count) {
      passed.slides[i] = slide as unknown as OutlineSlide;
    }
  });
  return { errors, passed };
}

/**
 * Every error and warning in an outline. `baseDir` is where image paths are resolved from. Lint runs over whatever
 * passed the structural check, so a missing alt text is listed beside a structural error rather than after its fix.
 */
export function checkOutline(input: unknown, baseDir: string): Checked {
  const { errors, passed } = checkStructure(input, baseDir);
  const issues = lint(passed);
  const said = (level: string) => issues.filter((issue) => issue.level === level).map((issue) => `${issue.where} ${issue.message}`);
  return { errors: [...errors, ...said("error")], warnings: said("warning") };
}

/** The outline, once it has no errors; throws OutlineError listing them otherwise. */
export function validateOutline(input: unknown, baseDir: string): { outline: Outline; warnings: string[] } {
  const { errors, warnings } = checkOutline(input, baseDir);
  if (errors.length > 0) {
    throw new OutlineError(errors);
  }
  return { outline: input as Outline, warnings };
}
