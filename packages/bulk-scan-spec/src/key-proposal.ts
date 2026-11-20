import type { Confidence } from "./similarity.ts";
import { assign, confidenceOf, tokens, words } from "./similarity.ts";

export interface KeySlot {
  /** The words that name this one key: a checkbox's own label, a text box's label. */
  label: string;
  /** Section heading and question wording around it, which carry who the field is about. */
  context: string;
}

export interface ProposedKey {
  key: string;
  reason: string;
  confidence: Confidence;
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
    .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
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

function uniqueKey(key: string, used: Set<string>, tag: string): string {
  let candidate = key;
  if (used.has(candidate.toLowerCase())) {
    candidate = `${key}${tag}`;
  }
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    candidate = `${key}${tag}${n}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * One key per slot. With house keys, a slot takes the existing key whose words best match its label and context (each key once);
 * otherwise the key is the label in camelCase, led by the house prefix that matches its context when there is one.
 */
export function proposeKeys(slots: KeySlot[], houseKeys: string[], tags: string[]): ProposedKey[] {
  const contexts = slots.map((s) => new Set([...tokens(s.label), ...tokens(s.context)]));
  const own = slots.map((s) => tokens(s.label));
  const reused = assign(
    contexts.map((context, i) => ({ context, own: own[i] as Set<string> })),
    houseKeys.map((id) => ({ id, words: tokens(id) })),
    MIN_REUSE,
    true
  );
  const prefixes = prefixesOf(houseKeys).map((p) => ({ prefix: p, words: tokens(p) }));
  const used = new Set([...reused.values()].map((r) => r.candidate.toLowerCase()));
  return slots.map((slot, i) => {
    const match = reused.get(i);
    if (match) {
      return {
        key: match.candidate,
        reason: `matches existing key ${match.candidate} (similarity ${match.score.toFixed(2)})`,
        confidence: confidenceOf(match.score)
      };
    }
    const party = prefixes
      .map((p) => ({ ...p, shared: [...p.words].filter((w) => contexts[i]?.has(w)).length }))
      .filter((p) => p.shared > 0)
      .sort((a, b) => b.shared - a.shared || b.words.size - a.words.size)[0];
    const base = camelCase(slot.label, party ? new Set(words(party.prefix)) : undefined) || "field";
    const key = party ? `${party.prefix}${base.charAt(0).toUpperCase()}${base.slice(1)}` : base;
    return {
      key: uniqueKey(key, used, tags[i] ?? ""),
      reason: party ? `new key from the label with house prefix ${party.prefix}` : "new key from the label; no existing key matched",
      confidence: "low"
    };
  });
}
