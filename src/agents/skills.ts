import { byCodePoint } from "../topics/slug.ts";

/** A Claude Code skill an agent's session reported it can run, offered by the composer's "/" autocomplete. */
export interface Skill {
  name: string;
  description: string;
}

export const MAX_SKILLS = 200;
export const MAX_SKILL_NAME = 100;
export const MAX_SKILL_DESCRIPTION = 300;
/** A plugin's skills are namespaced `plugin:skill`. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9:_-]*$/;

/** Sorted by name, the first of any repeated name kept. */
export function normaliseSkills(skills: readonly Skill[]): Skill[] {
  const seen = new Set<string>();
  const out: Skill[] = [];
  for (const skill of skills) {
    if (!seen.has(skill.name)) {
      seen.add(skill.name);
      out.push(skill);
    }
  }
  return out.sort((left, right) => byCodePoint(left.name, right.name));
}

/** The stored column, read defensively: anything that is not a valid skill is dropped rather than shown. */
export function storedSkills(value: unknown): Skill[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const skills: Skill[] = [];
  for (const entry of value.slice(0, MAX_SKILLS)) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const { name, description } = entry as Record<string, unknown>;
    if (typeof name === "string" && name.length <= MAX_SKILL_NAME && SKILL_NAME.test(name)) {
      skills.push({ name, description: typeof description === "string" ? description.slice(0, MAX_SKILL_DESCRIPTION) : "" });
    }
  }
  return normaliseSkills(skills);
}

/**
 * The skill name being typed: the text after a "/" that starts the message, while the caret is inside that leading
 * token. `null` when the message does not start with one or the caret has moved past it.
 */
export function skillQuery(body: string, caret: number): string | null {
  const token = /^\/[^\s]*/.exec(body)?.[0];
  if (token === undefined || caret < 1 || caret > token.length) {
    return null;
  }
  return token.slice(1);
}

/** Skills whose name starts with the query, then those whose description contains it, each in name order. */
export function matchSkills(skills: readonly Skill[], query: string): Skill[] {
  const needle = query.toLowerCase();
  const byName = skills.filter((skill) => skill.name.startsWith(needle));
  const byDescription = needle === "" ? [] : skills.filter((skill) => !skill.name.startsWith(needle) && skill.description.toLowerCase().includes(needle));
  return [...byName, ...byDescription];
}

/** The message with its leading "/" token replaced by the picked skill and a space, and where the caret goes. */
export function pickSkill(body: string, name: string): { body: string; caret: number } {
  const token = /^\/[^\s]*/.exec(body)?.[0] ?? "";
  const rest = body.slice(token.length);
  const head = `/${name} `;
  return { body: head + (rest.startsWith(" ") ? rest.slice(1) : rest), caret: head.length };
}
