/**
 * A person's override of the git `user.name` and `user.email` their virtual agents commit as, kept as the
 * `git_identity` credential: JSON with either or both. Without one, a pod uses their HMCTS email when it is on their
 * GitHub account and otherwise their GitHub noreply address. Nothing here touches Node, so the page's form shares
 * the limits with the server's check.
 */

export const MAX_GIT_NAME_CHARACTERS = 100;

/** The longest address SMTP allows. */
export const MAX_GIT_EMAIL_LENGTH = 254;

export interface GitIdentity {
  name?: string;
  email?: string;
}

/** Control characters, and the angle brackets git puts around an email, which would corrupt a commit's author line. */
const NOT_IN_NAME = /[\p{Cc}<>]/u;

/** One `@`, no spaces or angle brackets, and a dot in the domain: a plausible address, not a deliverable one. */
const EMAIL = /^[^\s@<>]+@[^\s@<>.]+(\.[^\s@<>.]+)+$/u;

export type CheckedGitIdentity = { ok: true; value: string } | { ok: false; error: string };

function field(object: Record<string, unknown>, key: string): string | undefined | null {
  const value = object[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Whether `raw`, the JSON a form or the CLI sends, is a git identity, stored as JSON of only the fields that are set.
 * An empty field is the same as none, and at least one of the two is needed.
 */
export function checkGitIdentity(raw: unknown): CheckedGitIdentity {
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : undefined;
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'a git identity is JSON like {"name": "…", "email": "…"}' };
  }
  const object = parsed as Record<string, unknown>;
  const unknown = Object.keys(object).filter((key) => key !== "name" && key !== "email");
  if (unknown.length > 0) {
    return { ok: false, error: "a git identity has only a name and an email" };
  }
  const name = field(object, "name");
  const email = field(object, "email");
  if (name === null || email === null) {
    return { ok: false, error: "a git identity's name and email are text" };
  }
  if (name === undefined && email === undefined) {
    return { ok: false, error: "set a name or an email, or clear the git identity" };
  }
  if (name !== undefined && (!name.isWellFormed() || NOT_IN_NAME.test(name))) {
    return { ok: false, error: "the git name cannot hold control characters or < >" };
  }
  if (name !== undefined && [...name].length > MAX_GIT_NAME_CHARACTERS) {
    return { ok: false, error: `the git name is at most ${MAX_GIT_NAME_CHARACTERS} characters` };
  }
  if (email !== undefined && email.length > MAX_GIT_EMAIL_LENGTH) {
    return { ok: false, error: `the git email is at most ${MAX_GIT_EMAIL_LENGTH} characters` };
  }
  if (email !== undefined && !EMAIL.test(email)) {
    return { ok: false, error: "that is not an email address" };
  }
  const identity: GitIdentity = {};
  if (name !== undefined) {
    identity.name = name;
  }
  if (email !== undefined) {
    identity.email = email;
  }
  return { ok: true, value: JSON.stringify(identity) };
}

/** A stored git identity for the page to show; anything unreadable shows as empty fields. */
export function readGitIdentity(stored: string | undefined): GitIdentity {
  if (stored === undefined) {
    return {};
  }
  const checked = checkGitIdentity(stored);
  return checked.ok ? (JSON.parse(checked.value) as GitIdentity) : {};
}
