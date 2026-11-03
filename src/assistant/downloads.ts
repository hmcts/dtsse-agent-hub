/** What a file the CFT Workspace hands a person is called when it lands in their downloads. */

/**
 * Windows refuses these as the part before the first dot, whatever follows it, so `NUL.txt` is as unusable as `NUL`
 * and both download under the fallback name.
 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** Long enough for any title worth reading in a downloads list, short enough to leave room in a path. */
const NAME_LIMIT = 80;

/**
 * The download's filename: the document's title, with everything a Windows, macOS or Linux filename cannot hold
 * taken out. A title that is only punctuation, or is a name Windows reserves, falls back to `document`.
 */
export function fileName(title: string, extension: string): string {
  const cleaned = title
    // biome-ignore lint/suspicious/noControlCharactersInRegex: a filename cannot hold them, which is why they go
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, NAME_LIMIT)
    // Leading and trailing dots and spaces are stripped by Windows and hide a file on Unix, so they go here instead.
    .replace(/^[\s.]+|[\s.]+$/g, "");
  const stem = cleaned.split(".")[0] ?? "";
  return `${cleaned === "" || RESERVED_NAMES.test(stem) ? "document" : cleaned}.${extension}`;
}

/** RFC 5987's `attr-char` is narrower than what `encodeURIComponent` leaves alone: these four are not in it. */
const NOT_ATTR_CHAR = /['()*]/g;

/**
 * The `Content-Disposition` of a download called `name`: an ASCII stand-in as `filename` for a client that reads no
 * other, and the real name as RFC 5987's `filename*`, percent-encoded UTF-8.
 */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(NOT_ATTR_CHAR, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
