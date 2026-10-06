/**
 * How many virtual agents a person may have, and what they may be called. Each one is a pod and a disk in the
 * preview cluster, so the limit is about capacity rather than access.
 */

/**
 * Agents a person may have, running or stopped; one being deleted no longer counts. All of them may run at once, so
 * starting one needs no check of its own.
 */
export const MAX_VIRTUAL_AGENTS_PER_USER = 3;

export const MAX_NAME_LENGTH = 64;

/** Lowercase letters, digits and single hyphens between them: it reads as a session name and survives any URL. */
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type CheckedName = { ok: true; name: string } | { ok: false; error: string };

export function checkName(raw: unknown): CheckedName {
  const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (name === "") {
    return { ok: false, error: "give the virtual agent a name" };
  }
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `a name is at most ${MAX_NAME_LENGTH} characters` };
  }
  if (!NAME.test(name)) {
    return { ok: false, error: "a name is lowercase letters, digits and hyphens, starting and ending with a letter or digit" };
  }
  return { ok: true, name };
}

/** Why the person, with `live` agents not being deleted, cannot create another, or `undefined` when they can. */
export function createRefusal(live: number): string | undefined {
  if (live >= MAX_VIRTUAL_AGENTS_PER_USER) {
    return `you already have ${MAX_VIRTUAL_AGENTS_PER_USER} virtual agents; delete one first`;
  }
  return undefined;
}
