/** Someone a comment can name with `@`: the project's team and the people who have commented on it. */
export interface MentionablePerson {
  oid: string;
  name: string;
}

/** Most mentions one comment records, so a pasted list of everyone is not a row per name. */
export const MAX_MENTIONS = 20;

const WORD = /[\p{L}\p{N}]/u;

/**
 * The people `body` names as `@Their Name`, each once, in the order first named. A name matches whole and without
 * regard to case, so `@Ann` does not name Anna, and the longest name wins where one is the start of another
 * (`@Ann Lee` over `@Ann`). An `@` inside a word, as in an address, names nobody.
 */
export function mentionsIn(body: string, people: readonly MentionablePerson[]): string[] {
  const candidates = people
    .filter((person) => person.name.trim() !== "")
    .map((person) => ({ oid: person.oid, name: person.name.trim().toLocaleLowerCase("en-GB") }))
    .sort((left, right) => right.name.length - left.name.length);
  const text = body.toLocaleLowerCase("en-GB");
  const found: string[] = [];
  for (let at = text.indexOf("@"); at !== -1 && found.length < MAX_MENTIONS; at = text.indexOf("@", at + 1)) {
    if (at > 0 && WORD.test(text[at - 1] as string)) {
      continue;
    }
    const rest = text.slice(at + 1);
    const match = candidates.find(({ name }) => rest.startsWith(name) && !WORD.test(rest.charAt(name.length)));
    if (match !== undefined && !found.includes(match.oid)) {
      found.push(match.oid);
    }
  }
  return found;
}
