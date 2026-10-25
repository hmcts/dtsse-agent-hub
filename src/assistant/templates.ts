import { TEMPLATES, type Template } from "./starters.ts";

/**
 * A person's own saved prompts: the caps, the checks and the refusals. Pure, so the settings dialog refuses in the
 * same words the server action does and neither has a rule the other has not got.
 *
 * Nothing here touches Node or Prisma: `template-store.ts` is the Postgres half, and calls `checkTemplate` so a
 * direct POST that skips the dialog is held to the same bounds.
 */

/** How many a person may keep. Enough for the handful anybody actually retypes, few enough to read in a menu. */
export const MAX_TEMPLATES = 20;

/** The composer's menu is 220px wide, so a name much longer than this is one nobody can read in it anyway. */
export const MAX_TEMPLATE_NAME = 60;

/** A template is the opening of a message, not the message: `MAX_BODY` is 32,000, and a prompt needs a fraction. */
export const MAX_TEMPLATE_BODY = 4_000;

/** Control characters (C0, DEL and C1) other than tab, line feed and carriage return. */
const CONTROL = /(?![\t\n\r])\p{Cc}/u;

/** One of the person's own, as the dialog lists it. The built-in ones have no id because there is nothing to edit. */
export interface SavedTemplate extends Template {
  id: string;
}

/**
 * Characters as a person counts them, and as Postgres's `char_length` does: code points, so an emoji is one rather
 * than the two UTF-16 units `String.length` would charge for. The counts shown and the `CHECK` in the migration
 * therefore agree, and no value the dialog says is short enough is refused by the database.
 */
export function templateLength(value: string): number {
  let count = 0;
  for (const _ of value) {
    count += 1;
  }
  return count;
}

export type CheckedTemplate = { ok: true; template: Template } | { ok: false; error: string };

/**
 * Whether `name` and `body` can be saved as a template, and the value to save.
 *
 * Both ends are trimmed and the body's line endings normalised, because a browser submits a textarea's newlines as
 * CRLF and a template is pasted straight into the message box — the hub should not put carriage returns, or a leading
 * blank line, into somebody's message.
 *
 * A name one of the built-in templates already uses is refused. The composer offers both lists from one menu and keys
 * its items on the name, so two of a name there is one item the person cannot choose between.
 */
export function checkTemplate(input: { name: unknown; body: unknown }): CheckedTemplate {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const raw = typeof input.body === "string" ? input.body : "";
  const body = raw.replace(/\r\n?/g, "\n").trim();
  if (name === "") {
    return { ok: false, error: "give your template a name" };
  }
  if (templateLength(name) > MAX_TEMPLATE_NAME) {
    return { ok: false, error: `a template name is at most ${MAX_TEMPLATE_NAME} characters` };
  }
  if (body === "") {
    return { ok: false, error: "write the prompt your template fills the message box with" };
  }
  if (templateLength(body) > MAX_TEMPLATE_BODY) {
    return { ok: false, error: `a template is at most ${MAX_TEMPLATE_BODY.toLocaleString("en-GB")} characters` };
  }
  // Postgres `text` holds neither a NUL nor a lone surrogate, so both are refused in words rather than as a failed
  // insert, and the rest of the C0 block is refused for the same reason a CLAUDE.md is: it is text a person typed.
  if (!name.isWellFormed() || !body.isWellFormed() || CONTROL.test(name) || CONTROL.test(body)) {
    return { ok: false, error: "a template can only hold printable text, tabs and new lines" };
  }
  if (TEMPLATES.some((built) => built.name === name)) {
    return { ok: false, error: `"${name}" is one of the built-in templates; give yours another name` };
  }
  return { ok: true, template: { name, text: body } };
}

/** What the store says when a person tries to keep one more than `MAX_TEMPLATES`. The dialog says it before they do. */
export const TEMPLATES_FULL = `you already have ${MAX_TEMPLATES} templates; delete one to make room`;

/** What the store says when the name is already one of the person's own. */
export function templateNameTaken(name: string): string {
  return `you already have a template called "${name}"`;
}

/**
 * What the composer's + menu offers: the person's own first, then the built-in ones.
 *
 * Both lists, rather than theirs replacing the built-in ones, because somebody with three saved prompts still wants
 * the Bug template, and a person with none would otherwise be offered nothing at all. Theirs first because they wrote
 * them and the built-in ones are the fallback. A built-in cannot be hidden: hiding would need a row per person per
 * built-in keyed on a name, which is not a stable id, so renaming a built-in would quietly unhide it for everyone who
 * had hidden it.
 */
export function offeredTemplates(mine: readonly Template[]): Template[] {
  return [...mine, ...TEMPLATES];
}
