/** What a file the CFT Workspace hands a person is called when it lands in their downloads. */

/**
 * Windows refuses these as the part before the first dot, whatever follows it, so `NUL.txt` is as unusable as `NUL`
 * and both download under the fallback name.
 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** Long enough for any title worth reading in a downloads list, short enough to leave room in a path. */
const NAME_LIMIT = 80;

/**
 * The longest start of `text` that is at most `max` UTF-16 code units and never ends inside a character: not inside a
 * surrogate pair, which has no UTF-8 and makes `encodeURIComponent` throw, and, where the runtime segments graphemes,
 * not between an emoji and its modifier or a letter and its accent.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const parts =
    typeof Intl.Segmenter === "function"
      ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part) => part.segment)
      : Array.from(text);
  let kept = "";
  for (const part of parts) {
    if (kept.length + part.length > max) {
      break;
    }
    kept += part;
  }
  return kept;
}

/**
 * The download's filename: the document's title, with everything a Windows, macOS or Linux filename cannot hold
 * taken out. A title that is only punctuation, or is a name Windows reserves, falls back to `document`.
 */
export function fileName(title: string, extension: string): string {
  const cleaned = clip(
    title
      // biome-ignore lint/suspicious/noControlCharactersInRegex: a filename cannot hold them, which is why they go
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " "),
    NAME_LIMIT
  )
    // Leading and trailing dots and spaces are stripped by Windows and hide a file on Unix, so they go here instead.
    .replace(/^[\s.]+|[\s.]+$/g, "");
  const stem = cleaned.split(".")[0] ?? "";
  return `${cleaned === "" || RESERVED_NAMES.test(stem) ? "document" : cleaned}.${extension}`;
}

/** RFC 5987's `attr-char` is narrower than what `encodeURIComponent` leaves alone: these four are not in it. */
const NOT_ATTR_CHAR = /['()*]/g;

/**
 * The `Content-Disposition` of a download called `name`: an ASCII stand-in as `filename` for a client that reads no
 * other, and the real name as RFC 5987's `filename*`, percent-encoded UTF-8. Half a surrogate pair has no UTF-8, so it
 * goes as U+FFFD rather than making `encodeURIComponent` throw and the download fail.
 */
export function attachmentDisposition(name: string): string {
  const whole = name.toWellFormed();
  const ascii = whole.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(whole).replace(NOT_ATTR_CHAR, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
