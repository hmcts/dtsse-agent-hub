/**
 * Escaping for the hub's two suggest-as-you-type searches, which both match with `LIKE` on text somebody is still
 * typing: `searchUsers` in `src/users/store.ts` and `searchTaggableAgents` in `src/agents/store.ts`.
 *
 * Here rather than with either feature because it is a fact about the database's pattern syntax and not about people
 * or agents, and because the two searches must not disagree about it.
 */

/** The characters `LIKE` reads as pattern rather than text, so a typed `%` matches a literal one. */
export function likeLiteral(value: string): string {
  return value.toLowerCase().replace(/[\\%_]/g, (character) => `\\${character}`);
}
