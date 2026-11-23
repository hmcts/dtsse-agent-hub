import type { Confidence } from "./similarity.ts";
import { assign, cap, confidenceOf, tokens, words } from "./similarity.ts";

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

/** The suffixes of a date's keys, as the sheets and nfdiv name them. */
export const DATE_PARTS = ["Day", "Month", "Year"] as const;

const MIN_REUSE = 0.55;
const MIN_PREFIX_USES = 3;
const MAX_WORDS = 5;

/** Plain camelCase of a label, from its first few meaningful words, leaving out leading words in `skip`. */
export function camelCase(label: string, skip: Set<string> = new Set()): string {
  const all = words(label);
  const lead = all.findIndex((w) => !skip.has(w));
  return all
    .slice(lead < 0 ? all.length : lead, (lead < 0 ? all.length : lead) + MAX_WORDS)
    .map((w, i) => (i === 0 ? w : cap(w)))
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
  "personal",
  "contact",
  "section",
  "about",
  "your",
  "own",
  "appealing",
  "appeal",
  "request",
  "application",
  "form",
  "behalf",
  "following",
  "reasons"
]);

/** Words that say who a section is about, which make the best prefix for a key another section already has. */
const PARTIES = new Set([
  "applicant",
  "applicant1",
  "applicant2",
  "appellant",
  "respondent",
  "representative",
  "solicitor",
  "minor",
  "child",
  "parent",
  "witness"
]);

/**
 * The word a section title is about, such as minor for "Appealing on behalf of a minor": the last party word in it, else
 * its one word that is not a qualifier. A title with several such words has no subject, since any one would mislead.
 */
export function subjectOf(title: string): string | undefined {
  const named = words(title).filter((w) => !/^\d+$/.test(w) && !GENERIC.has(w));
  return named.filter((w) => PARTIES.has(w)).at(-1) ?? (named.length === 1 ? named[0] : undefined);
}

/**
 * The first of these that `taken` allows: the key, then the key led by the section's subject, then that with the
 * question's tag, then with the tag and a number. The subject stays in the numbered form, and is left out of a key whose
 * first word it already is.
 */
function distinct(key: string, taken: (candidate: string) => boolean, tag: string, subject?: string): string {
  const first = key.split(/(?=[A-Z])/)[0]?.toLowerCase();
  const lead = taken(key) && subject && first !== subject.toLowerCase() ? `${subject}${cap(key)}` : key;
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
  const part = DATE_PARTS.find((p) => key.endsWith(p));
  return part ? key.slice(0, -part.length) : key;
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

  // A stem is a date's when the house has two or more of its Day, Month and Year keys; those keys go to date slots only.
  const stems = [...new Set(houseKeys.map(stemOf))].filter((stem) => DATE_PARTS.filter((part) => lower.has(`${stem}${part}`.toLowerCase())).length >= 2);
  const dateKeys = new Set(stems.flatMap((stem) => DATE_PARTS.map((part) => `${stem}${part}`.toLowerCase())));
  const dateMatches = assign(
    dated.map((i) => ({ context: contexts[i] as Set<string>, own: own[i] as Set<string> })),
    stems.map((stem) => ({ id: stem, words: tokens(stem) })),
    MIN_REUSE,
    true
  );
  const dateOf = new Map([...dateMatches].map(([n, match]) => [dated[n] as number, match]));

  const reused = assign(
    contexts.map((context, i) => ({ context: slots[i]?.parts ? new Set<string>() : context, own: own[i] as Set<string> })),
    houseKeys.filter((k) => !dateKeys.has(k.toLowerCase())).map((id) => ({ id, words: tokens(id) })),
    MIN_REUSE,
    true
  );
  const prefixes = prefixesOf(houseKeys).map((p) => ({ prefix: p, words: tokens(p) }));
  // A date's keys are taken from the start, as reused keys are, so no earlier slot is given one.
  const used = new Set(
    [...reused.values()]
      .map((r) => r.candidate.toLowerCase())
      .concat([...dateOf].flatMap(([i, match]) => (slots[i]?.parts ?? []).map((part) => `${match.candidate}${part}`.toLowerCase())))
  );
  /** What a slot with no existing key is named from: the house party prefix its context matches, else the section's subject. */
  const naming = (slot: KeySlot, i: number) => {
    const party = prefixes
      .map((p) => ({ ...p, shared: [...p.words].filter((w) => contexts[i]?.has(w)).length }))
      .filter((p) => p.shared > 0)
      .sort((a, b) => b.shared - a.shared || b.words.size - a.words.size)[0];
    const base = camelCase(slot.label, party ? new Set(words(party.prefix)) : undefined) || "field";
    return {
      party,
      proposed: party ? `${party.prefix}${cap(base)}` : base,
      // A key led by the house's party prefix already says who it is about, so the section's subject is left out of it.
      subject: slot.section && !party ? subjectOf(slot.section) : undefined
    };
  };
  return slots.map((slot, i) => {
    const tag = tags[i] ?? "";
    const { parts } = slot;
    if (parts) {
      const match = dateOf.get(i);
      const named = match ? undefined : naming(slot, i);
      const final = match
        ? match.candidate
        : distinct(named?.proposed ?? "field", (k) => parts.some((part) => used.has(`${k}${part}`.toLowerCase())), tag, named?.subject);
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
          : `keys ${keys.join(", ")}: new from the label with ${parts.join(", ")}${named?.party ? ` and house prefix ${named.party.prefix}` : ""}`;
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
    const { party, proposed, subject } = naming(slot, i);
    return {
      key: uniqueKey(proposed, used, tag, subject),
      reason: party ? `new key from the label with house prefix ${party.prefix}` : "new key from the label; no existing key matched",
      confidence: "low"
    };
  });
}
