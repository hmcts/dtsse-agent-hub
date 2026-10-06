/**
 * A person's own CLAUDE.md, which each of their virtual agents writes to `~/.claude/CLAUDE.md` before Claude starts.
 * It is kept as the `claude_md` credential because people may put private context in it. Nothing here touches Node,
 * so the page's editor shares the limit and the default with the server's check.
 */

/** What a virtual agent gets, and the page shows, while its owner has stored nothing. */
export const DEFAULT_CLAUDE_MD = "You are running in a pod in Preview and connected via the agent hub.";

export const MAX_CLAUDE_MD_CHARACTERS = 20_000;

/** A Key Vault secret value is at most 25 KB, so the UTF-8 bytes are capped too, with room for the encoding overhead. */
export const MAX_CLAUDE_MD_BYTES = 24_000;

/** Control characters (C0, DEL and C1) other than tab, line feed and carriage return. */
const CONTROL = /(?![\t\n\r])\p{Cc}/u;

/** Characters as a person counts them: code points, so an emoji is one rather than two UTF-16 units. */
export function claudeMdLength(text: string): number {
  let count = 0;
  for (const _ of text) {
    count += 1;
  }
  return count;
}

export type CheckedClaudeMd = { ok: true; value: string } | { ok: false; error: string };

/**
 * Whether `raw` can be stored as a CLAUDE.md. It is kept as written apart from line endings: a browser submits a
 * textarea's newlines as CRLF, which would otherwise reach the pod's file.
 */
export function checkClaudeMd(raw: unknown): CheckedClaudeMd {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, error: "write your CLAUDE.md, or reset it to the default" };
  }
  if (!raw.isWellFormed()) {
    return { ok: false, error: "your CLAUDE.md is not valid text" };
  }
  const value = raw.replace(/\r\n?/g, "\n");
  if (CONTROL.test(value)) {
    return { ok: false, error: "your CLAUDE.md can only hold printable text, tabs and new lines" };
  }
  if (claudeMdLength(value) > MAX_CLAUDE_MD_CHARACTERS) {
    return { ok: false, error: `your CLAUDE.md is at most ${MAX_CLAUDE_MD_CHARACTERS.toLocaleString("en-GB")} characters` };
  }
  if (new TextEncoder().encode(value).length > MAX_CLAUDE_MD_BYTES) {
    return {
      ok: false,
      error: `your CLAUDE.md is at most ${MAX_CLAUDE_MD_BYTES.toLocaleString("en-GB")} bytes as UTF-8; use fewer non-English characters or emoji`
    };
  }
  return { ok: true, value };
}
