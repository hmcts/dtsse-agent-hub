/**
 * Why a string a scan found probably needs no Welsh, in words for a BA, or null when it reads as content. A suggestion
 * only: the Welsh page starts some of these unticked for the Welsh Language Unit's spreadsheet (see `leaveOutSuggested`),
 * and a person decides. What is never content at all, and so is not even found, is `looksUntranslatable` in scan.ts.
 *
 * Each rule is narrow on purpose. A wrong hint leaves out words people read, which is worse than one missed: content
 * with a placeholder in it, a "Cookies" link, an "Address line 1" label all need Welsh.
 */

const POSTCODE = String.raw`[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}`;
/** A town and postcode, or a postcode alone, as an address's last line: "London EC2V 5AR". */
const POSTCODE_LINE = new RegExp(`^([A-Za-z' .-]+,? )?${POSTCODE}$`);
/** The last part of a key that holds a line of an address: `locationLine2`, `venueAddressLines.1`, `address.3`. */
const ADDRESS_LINE_KEY = /(^|\.)(locationLines?\d*|addressLines?\d*|venueAddressLines?\d*|address)(\.\d+)?$/i;
const PLACEHOLDER = /\$\{[^}]*\}|\{\{[^}]*\}\}|\\n/g;

export const CODE_HINT = "Built by code rather than written as words. A developer should check where its words come from.";

export function noWelshHint(english: string, key: string): string | null {
  const t = english.trim();
  // Only text that is placeholders and nothing else: "You have {{count}} cases" is content, with a placeholder in it.
  if (PLACEHOLDER.test(t) && !/\p{L}/u.test(t.replace(PLACEHOLDER, ""))) {
    return CODE_HINT;
  }
  if (/cookie/i.test(key) && looksLikeIdentifier(t)) {
    return "The name of a cookie, which has to match the cookie itself.";
  }
  if (ADDRESS_LINE_KEY.test(key) || POSTCODE_LINE.test(t)) {
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

/** One word written as code writes names: `dtCookie`, `rxvt`, `TSxxxxxxxx`, `_ga`. Not "Cookies" or "Accept". */
function looksLikeIdentifier(text: string): boolean {
  return !/\s/.test(text) && (/^[a-z_]/.test(text) || /[_\d]/.test(text) || /^[A-Z]{2,}[a-z]/.test(text) || /[a-z][A-Z]/.test(text));
}
