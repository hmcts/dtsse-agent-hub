import { capitalised } from "./capitalised.ts";
import type { Confidence } from "./similarity.ts";
import { assign, confidenceOf, tokens, words } from "./similarity.ts";

export interface KeySlot {
  /** The words that name this one key: a checkbox's own label, a text box's label. */
  label: string;
  /** Section heading and question wording around it, which carry who the field is about. */
  context: string;
  /** The section's own title, whose subject names a key that another section already has. */
  section?: string;
  /** The suffixes of a slot that carries several keys, such as a date's Day, Month and Year: its keys share one stem. */
  parts?: readonly string[];
}

export interface ProposedKey {
  key: string;
  reason: string;
  confidence: Confidence;
  /** The keys of a slot with `parts`, in order; `key` is the first. */
  parts?: ProposedKey[];
}

const MIN_REUSE = 0.55;
const MIN_PREFIX_USES = 3;
const MAX_WORDS = 5;

/** Plain camelCase of a label, from its first few meaningful words, leaving out leading words in `skip`. */
export function camelCase(label: string, skip: Set<string> = new Set()): string {
  const all = words(label);
  const lead = all.findIndex((w) => !skip.has(w));
  return all
    .slice(lead < 0 ? all.length : lead, (lead < 0 ? all.length : lead) + MAX_WORDS)
    .map((w, i) => (i === 0 ? w : capitalised(w)))
    .join("");
}

/** Leading party prefixes the house keys share, such as soleOrApplicant1, up to the first digit. */
function prefixesOf(houseKeys: string[]): string[] {
  const counts = new Map<string, number>();
  for (const key of houseKeys) {
    const prefix = /^[A-Za-z]*?\d/.exec(key)?.[0];
    if (prefix) {
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }
  return [...counts].filter(([, n]) => n >= MIN_PREFIX_USES).map(([p]) => p);
}

const GENERIC = new Set([
  "information",
  "details",
  "detail",
  "section",
  "appealing",
  "appeal",
  "about",
  "your",
  "request",
  "application",
  "form",
  "behalf",
  "following",
  "reasons"
]);

/** The word a section title is about, such as minor for "Appealing on behalf of a minor": its last word that is not generic. */
export function subjectOf(title: string): string | undefined {
  return words(title)
    .filter((w) => !/^\d+$/.test(w) && !GENERIC.has(w))
    .at(-1);
}

/**
 * The first of these that `taken` allows: the key, then the key led by the section's subject, then that with the
 * question's tag, then with the tag and a number. The subject stays in the numbered form, and is left out of a key that
 * already starts with it.
 */
function distinct(key: string, taken: (candidate: string) => boolean, tag: string, subject?: string): string {
  const lead = taken(key) && subject && !key.toLowerCase().startsWith(subject.toLowerCase()) ? `${subject}${capitalised(key)}` : key;
  let candidate = lead;
  if (taken(candidate)) {
    candidate = `${lead}${tag}`;
  }
  for (let n = 2; taken(candidate); n++) {
    candidate = `${lead}${tag}${n}`;
  }
  return candidate;
}

function uniqueKey(key: string, used: Set<string>, tag: string, subject?: string): string {
  const candidate = distinct(key, (k) => used.has(k.toLowerCase()), tag, subject);
  used.add(candidate.toLowerCase());
  return candidate;
}

/** A reused or proposed key without its trailing Day, Month or Year, which a date's own keys add back. */
function stemOf(key: string): string {
  return key.replace(/(Day|Month|Year)$/, "");
}

/**
 * One key per slot. With house keys, a slot takes the existing key whose words best match its label and context (each key once);
 * otherwise the key is the label in camelCase, led by the house prefix that matches its context when there is one.
 */
export function proposeKeys(slots: KeySlot[], houseKeys: string[], tags: string[]): ProposedKey[] {
  const contexts = slots.map((s) => new Set([...tokens(s.label), ...tokens(s.context)]));
  const own = slots.map((s) => tokens(s.label));
  const lower = new Set(houseKeys.map((k) => k.toLowerCase()));
  const dated = slots.flatMap((slot, i) => (slot.parts ? [i] : []));
  const partsOf = (i: number): readonly string[] => slots[i]?.parts ?? [];

  // A house key ending Day, Month or Year is a date's, never a plain slot's: a date slot takes its stem, and a stem whose
  // three keys all exist is the house's own date.
  const stems = [...new Set(houseKeys.flatMap((k) => (/(Day|Month|Year)$/.test(k) ? [stemOf(k)] : [])))];
  const dateMatches = assign(
    dated.map((i) => ({ context: contexts[i] as Set<string>, own: own[i] as Set<string> })),
    stems.map((stem) => ({ id: stem, words: tokens(stem) })),
    MIN_REUSE,
    true
  );
  const dateOf = new Map([...dateMatches].map(([n, match]) => [dated[n] as number, match]));
  const reservedByDates = new Set([...dateOf].flatMap(([i, match]) => partsOf(i).map((part) => `${match.candidate}${part}`.toLowerCase())));

  const reused = assign(
    contexts.map((context, i) => ({ context: slots[i]?.parts ? new Set<string>() : context, own: own[i] as Set<string> })),
    houseKeys.filter((k) => !reservedByDates.has(k.toLowerCase()) && !/(Day|Month|Year)$/.test(k)).map((id) => ({ id, words: tokens(id) })),
    MIN_REUSE,
    true
  );
  const prefixes = prefixesOf(houseKeys).map((p) => ({ prefix: p, words: tokens(p) }));
  const used = new Set([...reused.values()].map((r) => r.candidate.toLowerCase()).concat([...reservedByDates]));
  return slots.map((slot, i) => {
    const tag = tags[i] ?? "";
    const party = prefixes
      .map((p) => ({ ...p, shared: [...p.words].filter((w) => contexts[i]?.has(w)).length }))
      .filter((p) => p.shared > 0)
      .sort((a, b) => b.shared - a.shared || b.words.size - a.words.size)[0];
    // A key led by the house's party prefix already says who it is about, so the section's subject is left out of it.
    const subject = slot.section && !party ? subjectOf(slot.section) : undefined;
    const base = camelCase(slot.label, party ? new Set(words(party.prefix)) : undefined) || "field";
    const proposed = party ? `${party.prefix}${capitalised(base)}` : base;
    const { parts } = slot;
    if (parts) {
      const match = dateOf.get(i);
      const final = match ? match.candidate : distinct(proposed, (k) => parts.some((part) => used.has(`${k}${part}`.toLowerCase())), tag, subject);
      const keys = parts.map((part) => `${final}${part}`);
      for (const key of keys) {
        used.add(key.toLowerCase());
      }
      const house = match !== undefined && keys.every((key) => lower.has(key.toLowerCase()));
      const confidence = match ? confidenceOf(match.score) : "low";
      const reason = house
        ? `matches existing keys ${keys.join(", ")} (similarity ${match.score.toFixed(2)})`
        : match
          ? `keys ${keys.join(", ")}: built on the existing ${final} keys with ${parts.join(", ")} (similarity ${match.score.toFixed(2)})`
          : `keys ${keys.join(", ")}: new from the label with ${parts.join(", ")}${party ? ` and house prefix ${party.prefix}` : ""}`;
      return { key: keys[0] as string, reason, confidence, parts: keys.map((key) => ({ key, reason, confidence })) };
    }
    const match = reused.get(i);
    if (match) {
      return {
        key: match.candidate,
        reason: `matches existing key ${match.candidate} (similarity ${match.score.toFixed(2)})`,
        confidence: confidenceOf(match.score)
      };
    }
    return {
      key: uniqueKey(proposed, used, tag, subject),
      reason: party ? `new key from the label with house prefix ${party.prefix}` : "new key from the label; no existing key matched",
      confidence: "low"
    };
  });
}
