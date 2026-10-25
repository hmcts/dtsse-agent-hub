import { canViewConversation } from "../access/rules.ts";
import { collapse, oneLine } from "../transcripts/conversation.ts";

/**
 * Searching a person's own Assistant conversations: what counts as a term, what a result shows of the message it
 * matched, and the check that nothing but the searcher's own chats comes back.
 *
 * Pure, so what a person feels while typing is tested without a database and `store.ts` holds only the query.
 *
 * Each term is matched by Postgres full-text search — `to_tsquery('english', '<term>:*')` against a `tsvector` of the
 * title and of what was said — rather than by `ILIKE '%term%'`. Two reasons, one measured and one about the words:
 *
 * - `ILIKE` cannot use an index with a wildcard at the front, so every search read every direct message in the hub:
 *   62ms for one term and 117ms for two over one person's 12,000 messages, growing with everybody's traffic. The
 *   same searches answer in 8–9ms through the `GIN` index of `20261027090000_assistant_search`, and now grow with
 *   how much matches rather than with how much there is.
 * - These are short English strings, so stemming is what a person expects: "claims" finds "claim", "hearings" finds
 *   "hearing". The `:*` keeps a part-typed word matching, so "poss" still finds "possession" as it is typed. What is
 *   given up is matching inside a word — "ssession" no longer finds "possession" — which no search box offers.
 *
 * Trigram matching (`pg_trgm`) would have kept that and been indexed, but needs an extension created in the database,
 * which the Azure servers only allow once `azure.extensions` lists it; full-text search needs nothing installed.
 */

/** A term shorter than this is dropped: one letter is in nearly every chat, so it narrows nothing. */
export const MIN_TERM = 2;

/** Terms past this are ignored. A search is a few remembered words; more only costs the database another pass. */
export const MAX_TERMS = 6;

/** A term is cut to this, so a pasted paragraph cannot become one enormous query. */
export const MAX_TERM = 64;

/** The longest query a request may carry, before it is split into terms. */
export const MAX_QUERY = 200;

/** How many chats a search answers with, most recently active first: more than a sidebar list is read down. */
export const SEARCH_LIMIT = 50;

/** The words `ts_headline` keeps around a match, and how much of that a result shows. */
export const SNIPPET_MAX_WORDS = 28;
export const SNIPPET_MIN_WORDS = 12;
export const SNIPPET_LENGTH = 160;

/**
 * The words a query looks for: lower-cased, without repeats, in the order they were typed.
 *
 * Every one of them has to match for a chat to count, and each may match the title or any one message, so
 * "possession claim" finds the chat that mentions both however far apart they are. An empty list means there is
 * nothing worth searching for, and the sidebar keeps its usual list.
 */
export function searchTerms(query: string): string[] {
  const terms: string[] = [];
  for (const word of collapse(query).toLowerCase().split(" ")) {
    const term = word.slice(0, MAX_TERM);
    if (term.length >= MIN_TERM && !terms.includes(term)) {
      terms.push(term);
    }
    if (terms.length === MAX_TERMS) {
      return terms;
    }
  }
  return terms;
}

/**
 * What a result shows of the message it matched, on one line. `null` when the match was in the title, which the
 * result already shows, and when the words around the match turn out to be nothing but whitespace.
 */
export function snippetOf(excerpt: string | null): string | null {
  if (excerpt === null) {
    return null;
  }
  const line = oneLine(excerpt, SNIPPET_LENGTH);
  return line === "" ? null : line;
}

export class ForeignConversation extends Error {
  constructor() {
    super("a conversation search answered with a chat its searcher may not see");
  }
}

/**
 * The rows a search may answer with.
 *
 * The query's own `owner_oid` is what keeps a search to the searcher's own chats; this is the check that it did.
 * Conversations are owner-only and are on no roster, so a search that quietly widened would show someone else's
 * chats with no other symptom. A row the rule refuses is therefore a bug rather than a row to leave out, and it
 * stops the whole search instead of being filtered away where nobody would see it.
 */
export function visibleMatches<T extends { ownerOid: string }>(viewerOid: string, rows: readonly T[]): T[] {
  for (const row of rows) {
    if (!canViewConversation(viewerOid, row)) {
      throw new ForeignConversation();
    }
  }
  return [...rows];
}
