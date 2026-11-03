/**
 * Why a string a scan found probably needs no Welsh, in words for a BA, or null when it reads as content. A suggestion
 * only: the Welsh page starts some of these unticked for the Welsh Language Unit's spreadsheet (see `leaveOutSuggested`),
 * and a person decides. What is never content at all, and so is not even found, is `looksUntranslatable` in scan.ts.
 *
 * Each rule is narrow on purpose. A wrong hint leaves out words people read, which is worse than one missed: content
 * with a placeholder in it, a "Cookies" link, an "Address line 1" label all need Welsh.
 */

/** A postcode at the end of the text, after a space or nothing. */
const POSTCODE_AT_END = /(?:^|\s)([A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})$/;
/** The last part of a key that holds a line of an address: `locationLine2`, `venueAddressLines.1`, `address.3`. */
const ADDRESS_LINE_KEY = /(^|\.)(locationLines?\d*|addressLines?\d*|venueAddressLines?\d*|address)(\.\d+)?$/i;

export const CODE_HINT = "Built by code rather than written as words. A developer should check where its words come from.";

export function noWelshHint(english: string, key: string): string | null {
  const t = english.trim();
  // Only text that is placeholders and nothing else: "You have {{count}} cases" is content, with a placeholder in it.
  const words = withoutPlaceholders(t);
  if (words !== t && !/\p{L}/u.test(words)) {
    return CODE_HINT;
  }
  if (/cookie/i.test(key) && looksLikeIdentifier(t)) {
    return "The name of a cookie, which has to match the cookie itself.";
  }
  if (ADDRESS_LINE_KEY.test(key) || isPostcodeLine(t)) {
    return "Part of an address. Addresses in England usually stay in English; ask the Welsh unit if you are not sure.";
  }
  if (/^[A-Z]?[a-z]+(?:[A-Z][a-z]+)+$/.test(t)) {
    return "Looks like the name of a product or system, which usually stays in English.";
  }
  return null;
}

/**
 * Whether the page should start a hinted string unticked. Only when leaving it out is safe: it can be kept in English
 * for good (its Welsh is the English already), or it is code a developer must sort out either way. A hinted string
 * with no Welsh at all stays ticked, since left out it would have no Welsh ever.
 */
export function leaveOutSuggested(hint: string | null, keepable: boolean): boolean {
  return hint !== null && (keepable || hint === CODE_HINT);
}

/**
 * The text with every `${…}` and `{{…}}` taken out, and any `\n` escape a scan read literally. A scan of the string,
 * not a regular expression, so a long run of braces cannot make it backtrack.
 */
function withoutPlaceholders(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const open = closerAt(text, i);
    const close = open === null ? -1 : text.indexOf(open, i + 2);
    if (open !== null && close >= 0) {
      i = close + open.length;
    } else if (text.startsWith("\\n", i)) {
      i += 2;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

/** What closes a placeholder opening at `i`, or null when none opens there. */
function closerAt(text: string, i: number): string | null {
  if (text.startsWith("${", i)) {
    return "}";
  }
  return text.startsWith("{{", i) ? "}}" : null;
}

/** A town and postcode, or a postcode alone, as an address's last line: "London EC2V 5AR", not "for example SW1A 1AA". */
function isPostcodeLine(text: string): boolean {
  const postcode = POSTCODE_AT_END.exec(text)?.[1];
  if (postcode === undefined) {
    return false;
  }
  const town = text
    .slice(0, text.length - postcode.length)
    .trimEnd()
    .replace(/,$/, "");
  return /^[A-Za-z' .-]*$/.test(town);
}

/** One word written as code writes names: `dtCookie`, `rxvt`, `TSxxxxxxxx`, `_ga`. Not "Cookies" or "Accept". */
function looksLikeIdentifier(text: string): boolean {
  return !/\s/.test(text) && (/^[a-z_]/.test(text) || /[_\d]/.test(text) || /^[A-Z]{2,}[a-z]/.test(text) || /[a-z][A-Z]/.test(text));
}
