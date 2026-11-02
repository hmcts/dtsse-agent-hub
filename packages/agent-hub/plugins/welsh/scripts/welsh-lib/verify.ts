/**
 * The guard behind the "no AI Welsh" rule. Every Welsh value about to be
 * written anywhere must be, verbatim, either an approved catalogue rendering
 * of that exact English or a row of a Welsh Language Unit return. A
 * placeholder marker is always allowed. Anything else fails.
 */

import { type Catalogue, lookup } from "./catalogue.ts";
import { matchKey } from "./normalise.ts";

export const MARKER = (english: string) => `[WELSH TRANSLATION REQUIRED: "${english.replace(/"/g, "'")}"]`;

/** Placeholder forms seen across the services. Built-in; config may add more. */
export const PLACEHOLDER_PATTERNS: RegExp[] = [
  /\[WELSH TRANSLATION REQUIRED:/i,
  /\[TRANSLATE:/i,
  /^welsh placeholder$/i,
  /\[Translation in progress\]/i,
  /\[NO APPROVED WELSH\]/i,
  /\bcy(?=[A-Z<])|^cy\s+(?=[A-Za-z<])/
];

export function isPlaceholder(welsh: string, extra: RegExp[] = []): boolean {
  return welsh.trim() === "" || [...PLACEHOLDER_PATTERNS, ...extra].some((re) => re.test(welsh));
}

export function verify(values: Pair[], catalogues: Catalogue[], returns: Pair[] = []): VerifyResult {
  const fromReturns = new Map<string, Set<string>>();
  for (const r of returns) {
    const key = matchKey(r.english);
    fromReturns.set(key, (fromReturns.get(key) ?? new Set()).add(r.welsh));
  }
  const failures: VerifyFailure[] = [];
  let placeholders = 0;
  let traced = 0;
  for (const v of values) {
    if (isPlaceholder(v.welsh)) {
      placeholders++;
      continue;
    }
    const approved = catalogues.flatMap((c) => c.approved(v.english)).map((r) => r.welsh);
    if (approved.includes(v.welsh) || fromReturns.get(matchKey(v.english))?.has(v.welsh)) {
      traced++;
      continue;
    }
    const best = lookup(v.english, catalogues);
    failures.push({
      ...v,
      reason: approved.length
        ? "Welsh differs from every approved catalogue rendering of this English"
        : best.kind === "miss"
          ? "no approved catalogue row or WLU return for this English"
          : "catalogue rendering is not approved for automatic use"
    });
  }
  return { ok: failures.length === 0, checked: values.length, traced, placeholders, failures };
}

export interface Pair {
  english: string;
  welsh: string;
  where?: string;
}

export interface VerifyFailure extends Pair {
  reason: string;
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  traced: number;
  placeholders: number;
  failures: VerifyFailure[];
}
