// What the client's GitHub export and GitHub lookups share: the shape of an owner and a repository, which every value
// is checked against before it goes into a gh argument, and the one line said when gh refuses.
import { type RunResult, stripAnsi } from "./virtual/process.ts";

/** A GitHub user or organisation login: letters, digits and hyphens, not starting with a hyphen. */
export const GITHUB_OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/**
 * A repository as `owner/name`. A name is letters, digits, `.`, `_` and `-`, and may start with a dot, as
 * `hmcts/.github` does, but is never `.` or `..`. The hub's `src/assistant/github.ts` and its migrations check the same.
 */
export const GITHUB_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

/**
 * Why gh failed, in one line the person can read: `said`, then the first line gh wrote that is not JSON, ANSI escapes
 * stripped, at most `max` characters; `said` alone when gh wrote nothing.
 */
export function ghSaid(result: RunResult, said: string, max: number): string {
  const line =
    stripAnsi(`${result.stderr}\n${result.stdout}`)
      .split("\n")
      .map((text) => text.trim())
      .find((text) => text !== "" && !text.startsWith("{")) ?? "";
  const out = line ? `${said}: ${line}` : said;
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}
