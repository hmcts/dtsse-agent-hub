/**
 * Checks an outline read from a file: its shape, its layouts and fields, that its images exist, and then `lint`'s
 * limits and alt text. Errors stop the build; text over a limit is only a warning, since the slide still renders.
 */

import { existsSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { lint, MASTERS, type MasterSpec, masterNamed, type Outline } from "./masters.ts";

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

const IMAGE_TYPES = new Set([".png", ".jpg", ".jpeg", ".gif"]);
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
  } else if (!IMAGE_TYPES.has(extname(file).toLowerCase())) {
    errors.push(`${where}.path ${value.path} is not a PNG, JPEG or GIF`);
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

function checkStructure(input: unknown, baseDir: string): string[] {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return ["the outline must be a JSON object with title and slides"];
  }
  const { slides, ...top } = input;
  if (top.id !== undefined || top.layout !== undefined) {
    errors.push("outline takes title, subtitle, notes and slides; id and layout belong on a slide");
  }
  checkFields("outline", top, masterNamed("HMCTS_TITLE") as MasterSpec, baseDir, errors);
  if (!Array.isArray(slides) || slides.length === 0) {
    errors.push("outline.slides must be a non-empty list");
    return errors;
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
    checkFields(where, slide, master, baseDir, errors);
  });
  return errors;
}

/** Every error and warning in an outline. `baseDir` is where image paths are resolved from. */
export function checkOutline(input: unknown, baseDir: string): Checked {
  const errors = checkStructure(input, baseDir);
  if (errors.length > 0) {
    return { errors, warnings: [] };
  }
  const issues = lint(input as Outline);
  const said = (level: string) => issues.filter((issue) => issue.level === level).map((issue) => `${issue.where} ${issue.message}`);
  return { errors: said("error"), warnings: said("warning") };
}

/** The outline, once it has no errors; throws OutlineError listing them otherwise. */
export function validateOutline(input: unknown, baseDir: string): { outline: Outline; warnings: string[] } {
  const { errors, warnings } = checkOutline(input, baseDir);
  if (errors.length > 0) {
    throw new OutlineError(errors);
  }
  return { outline: input as Outline, warnings };
}
