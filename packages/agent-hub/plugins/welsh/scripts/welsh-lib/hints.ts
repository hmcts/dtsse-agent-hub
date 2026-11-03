/**
 * Why a string a scan found probably needs no Welsh, in words for a BA, or null when it reads as content. A suggestion
 * only: the Welsh page starts these unticked for the Welsh Language Unit's spreadsheet, and a person decides. What is
 * never content at all, and so is not even found, is `looksUntranslatable` in scan.ts.
 */

const POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b/;
const ADDRESS_KEY = /address|locationline|venue|street|postcode/i;

export function noWelshHint(english: string, key: string): string | null {
  const t = english.trim();
  if (/\$\{|\{\{/.test(t)) {
    return "Built by code rather than written as words. A developer should check where its words come from.";
  }
  if (/cookies?\b/i.test(key) && !/\s/.test(t)) {
    return "The name of a cookie, which has to match the cookie itself.";
  }
  if (POSTCODE.test(t) || ADDRESS_KEY.test(key)) {
    return "Part of an address. Addresses in England usually stay in English; ask the Welsh unit if you are not sure.";
  }
  if (/^[A-Z]?[a-z]+(?:[A-Z][a-z]+)+$/.test(t)) {
    return "Looks like the name of a product or system, which usually stays in English.";
  }
  return null;
}
