import { byCode } from "./compare.ts";

const ALIASES = new Map([
  ["no", "number"],
  ["ref", "reference"]
]);

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "to",
  "is",
  "are",
  "do",
  "does",
  "you",
  "your",
  "if",
  "and",
  "or",
  "this",
  "that",
  "for",
  "in",
  "on",
  "be",
  "by",
  "as",
  "have",
  "has",
  "what",
  "which",
  "any",
  "there",
  "it",
  "with",
  "applicable",
  "optional",
  "please",
  "box",
  "check",
  "tick"
]);

/** Lower-case words of a label or camelCase key, in order; "applicant 1" is one word, and possessives and filler words are dropped. */
export function words(text: string): string[] {
  return text
    .replace(/\([^)]*\)/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/applicant\s+(\d)/g, "applicant$1")
    .replace(/[’']s\b/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "" && !STOPWORDS.has(w))
    .map((w) => ALIASES.get(w) ?? w);
}

/** The words of a label or key with plurals folded, so that "names" and "name" match. */
export function tokens(text: string): Set<string> {
  return new Set(words(text).map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)));
}

/** Dice coefficient of two word sets: 1 when they are the same, 0 when they share nothing. */
export function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const w of a) {
    shared += b.has(w) ? 1 : 0;
  }
  return (2 * shared) / (a.size + b.size);
}

export type Confidence = "low" | "medium" | "high";

export function confidenceOf(score: number): Confidence {
  return score >= 0.8 ? "high" : score >= 0.6 ? "medium" : "low";
}

/** The share of `part` that `whole` contains. */
function coverage(part: Set<string>, whole: Set<string>): number {
  if (part.size === 0) {
    return 0;
  }
  return [...part].filter((w) => whole.has(w)).length / part.size;
}

export interface Slot {
  /** Everything around the slot that may help name it. */
  context: Set<string>;
  /** The slot's own words; when given, a candidate must also cover them. */
  own?: Set<string>;
}

export interface Scored {
  slot: number;
  candidate: string;
  score: number;
}

/** Each slot gets its best candidate scoring at least `threshold`; with `exclusive`, a candidate goes to one slot only, highest scores first. */
export function assign(slots: Slot[], candidates: { id: string; words: Set<string> }[], threshold: number, exclusive: boolean): Map<number, Scored> {
  const score = (words: Set<string>, slot: Slot): number =>
    slot.own ? (coverage(words, slot.context) + coverage(slot.own, words)) / 2 : dice(words, slot.context);
  const all: Scored[] = slots.flatMap((slot, i) =>
    candidates.map((c) => ({ slot: i, candidate: c.id, score: score(c.words, slot) })).filter((s) => s.score >= threshold)
  );
  all.sort((a, b) => b.score - a.score || a.slot - b.slot || byCode(a.candidate, b.candidate));
  const result = new Map<number, Scored>();
  const taken = new Set<string>();
  for (const s of all) {
    if (!result.has(s.slot) && !(exclusive && taken.has(s.candidate))) {
      result.set(s.slot, s);
      taken.add(s.candidate);
    }
  }
  return result;
}
