/**
 * How many virtual agents a person may have, and what they may be called. Each one is a pod and a disk in the
 * preview cluster, so the limits are about capacity rather than access.
 */

/** Agents meant to be running at once, per person. */
export const MAX_RUNNING_PER_USER = 2;

/** Agents a person may have at all, running or stopped; one being deleted no longer counts. */
export const MAX_PER_USER = 3;

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

export interface Counts {
  /** Agents not being deleted. */
  total: number;
  /** Agents meant to be running. */
  running: number;
}

/** Why the person cannot create another virtual agent, or `undefined` when they can. */
export function createRefusal(counts: Counts): string | undefined {
  if (counts.total >= MAX_PER_USER) {
    return `you already have ${MAX_PER_USER} virtual agents; delete one first`;
  }
  return startRefusal(counts);
}

/** Why the person cannot start another virtual agent, or `undefined` when they can. */
export function startRefusal(counts: Pick<Counts, "running">): string | undefined {
  if (counts.running >= MAX_RUNNING_PER_USER) {
    return `you already have ${MAX_RUNNING_PER_USER} virtual agents running; stop one first`;
  }
  return undefined;
}
