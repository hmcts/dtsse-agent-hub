import { describe, expect, it } from "vitest";
import { ForeignConversation, MAX_TERM, MAX_TERMS, searchTerms, snippetOf, visibleMatches } from "./search.ts";

describe("searchTerms", () => {
  it("should take the words of a query, lower-cased, when one is typed", () => {
    expect(searchTerms("Possession Claim")).toEqual(["possession", "claim"]);
  });

  it("should collapse whatever whitespace separates the words", () => {
    expect(searchTerms("  possession \n\t claim  ")).toEqual(["possession", "claim"]);
  });

  it("should search for a word once when it is typed twice", () => {
    expect(searchTerms("claim claim")).toEqual(["claim"]);
  });

  it("should find nothing worth searching for in an empty query", () => {
    expect(searchTerms("   ")).toEqual([]);
  });

  // A single letter is in nearly every chat, so searching for one would answer with the list the sidebar already
  // shows while looking like a search that had failed to narrow anything.
  it("should find nothing worth searching for in a one-letter query", () => {
    expect(searchTerms("a")).toEqual([]);
  });

  it("should drop a one-letter word from a query that has longer ones too", () => {
    expect(searchTerms("a possession claim")).toEqual(["possession", "claim"]);
  });

  it("should stop at its limit when a query carries more words than that", () => {
    const terms = searchTerms("one two three four five six seven eight");

    expect(terms).toHaveLength(MAX_TERMS);
    expect(terms).toEqual(["one", "two", "three", "four", "five", "six"]);
  });

  // A backslash is the one character that must not reach the query: `quote_literal` answers with its `E'…'` escape
  // form for anything carrying one, and that form is not valid tsquery input. A space rather than nothing, because
  // a backslash separates words, and the text-search parser splits a path at the same place.
  it.each([
    ["c:\\temp", ["c:", "temp"]],
    ["src\\main\\java", ["src", "main", "java"]],
    ["d:\\", ["d:"]],
    ["\\\\share\\logs", ["share", "logs"]]
  ])("should look for the words either side of a backslash when the query has one, as %s does", (query, expected) => {
    expect(searchTerms(query)).toEqual(expected);
  });

  it("should cut a term down when one word is longer than a term may be", () => {
    expect(searchTerms("x".repeat(MAX_TERM + 10))).toEqual(["x".repeat(MAX_TERM)]);
  });
});

describe("snippetOf", () => {
  it("should put the words around the match on one line", () => {
    expect(snippetOf("about a   possession\nclaim")).toBe("about a possession claim");
  });

  it("should show nothing when the match was in the title and no message was read", () => {
    expect(snippetOf(null)).toBeNull();
  });

  it("should show nothing when the words around the match are nothing but whitespace", () => {
    expect(snippetOf("   \n ")).toBeNull();
  });

  it("should cut a long excerpt down", () => {
    const snippet = snippetOf("word ".repeat(100));

    expect(snippet?.length).toBeLessThanOrEqual(160);
    expect(snippet?.endsWith("…")).toBe(true);
  });
});

describe("visibleMatches", () => {
  it("should answer with the searcher's own chats", () => {
    const rows = [{ ownerOid: "alice", id: "c1" }];

    expect(visibleMatches("alice", rows)).toEqual(rows);
  });

  // Conversations are owner-only and are in no roster, so a search that widened would show someone else's chats with
  // no other symptom at all. Nothing is quietly left out: the whole search stops.
  it("should refuse the whole search when a row belongs to someone else", () => {
    expect(() =>
      visibleMatches("alice", [
        { ownerOid: "alice", id: "c1" },
        { ownerOid: "bob", id: "c2" }
      ])
    ).toThrow(ForeignConversation);
  });
});
