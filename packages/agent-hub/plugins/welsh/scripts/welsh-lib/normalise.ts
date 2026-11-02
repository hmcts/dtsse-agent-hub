/**
 * Text normalisation for matching English against the catalogue.
 *
 * Normalisation is only ever used to build a *lookup key*. Welsh text is never
 * normalised: whatever the Welsh Language Unit wrote is what gets written out.
 */

const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032]/g;
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u2033]/g;
const SPACES = /\s+/g;
const WRAPPING_QUOTES = /^(["'])(.*)\1$/s;

/** Annotations the WLU uses to offer more than one rendering in one cell. */
const VARIANT_MARKERS = /\[(male|female|masculine|feminine|plural|singular|formal|informal)\]/i;

/**
 * Lookup key: NFC, straight quotes, single spaces, no wrapping quotes.
 * Case and punctuation are kept — "Back" and "back" can differ in Welsh.
 */
export function matchKey(text: string): string {
  let key = text.normalize("NFC").replace(SINGLE_QUOTES, "'").replace(DOUBLE_QUOTES, '"').replace(SPACES, " ").trim();
  let unwrapped = key.match(WRAPPING_QUOTES);
  while (unwrapped) {
    key = unwrapped[2].trim();
    unwrapped = key.match(WRAPPING_QUOTES);
  }
  return key;
}

/** Looser key used only to *suggest* matches; never used to fill. */
export function looseKey(text: string): string {
  return matchKey(text)
    .toLowerCase()
    .replace(/[.:;,!?]+$/, "")
    .trim();
}

/** Two Welsh strings that differ only in apostrophe/quote style or spacing. */
export function sameWelsh(a: string, b: string): boolean {
  return matchKey(a) === matchKey(b);
}

/** Welsh cell holds alternatives (e.g. "[male] / [female]") and cannot be used verbatim. */
export function hasVariants(welsh: string): boolean {
  return VARIANT_MARKERS.test(welsh);
}

/**
 * Split a legacy catalogue English cell such as
 *   “of” (as in, page 3 *of* 6)
 * into the quoted English and the usage note. Only splits when the cell starts
 * with a quoted phrase followed by more text — an unquoted "(opens in new tab)"
 * is real content and stays put.
 */
export function splitLegacyEnglish(cell: string): { english: string; context: string } {
  const text = cell.normalize("NFC").replace(SPACES, " ").trim();
  const quoted = text.match(/^[“"‘']([^”"’']+)[”"’']\s*(.*)$/s);
  if (quoted?.[2]) {
    const rest = quoted[2].replace(/^\((.*)\)$/s, "$1").trim();
    return { english: quoted[1].trim(), context: rest };
  }
  return { english: matchKey(text), context: "" };
}
