import { byCodePoint } from "../topics/slug.ts";
import { DOCMOSIS_LIBRARY, type IndexEntry } from "./docmosis-library.ts";

/**
 * Searching the template library's index in the browser, on every keystroke, over the whole index the hub handed it.
 * Pure and importing nothing of Node's, since the panel runs it.
 */

export interface PreparedTemplate {
  path: string;
  blobSha: string;
  size: number;
  /** The file's name, `.docx` and all, as the list shows it. */
  name: string;
  /** The folder directly under the library's own, which the folder chips filter on; `""` for a file at its top. */
  folder: string;
  stem: string;
  folderLower: string;
  words: string[];
}

export const DEFAULT_SEARCH_LIMIT = 50;

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

/** Each entry as the search reads it, worked out once per index rather than once per keystroke. */
export function prepare(entries: readonly IndexEntry[], root: string = DOCMOSIS_LIBRARY.path): PreparedTemplate[] {
  const prefix = `${root}/`;
  return entries.map(([path, blobSha, size]) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const inner = path.startsWith(prefix) ? path.slice(prefix.length) : path;
    const slash = inner.indexOf("/");
    const folder = slash === -1 ? "" : inner.slice(0, slash);
    const stem = name.replace(/\.docx$/i, "").toLowerCase();
    return {
      path,
      blobSha,
      size,
      name,
      folder,
      stem,
      folderLower: folder.toLowerCase(),
      words: stem.split(WORD_SPLIT).filter((word) => word !== "")
    };
  });
}

/** How well one token matches, best first; `undefined` when it matches neither the name nor the folder. */
function tokenRank(template: PreparedTemplate, token: string): number | undefined {
  if (template.stem.startsWith(token)) {
    return 0;
  }
  if (template.words.some((word) => word.startsWith(token))) {
    return 1;
  }
  if (template.stem.includes(token)) {
    return 2;
  }
  return template.folderLower.includes(token) ? 3 : undefined;
}

interface Ranked {
  template: PreparedTemplate;
  rank: number;
}

const byRank = (a: Ranked, b: Ranked): number =>
  a.rank - b.rank || a.template.path.length - b.template.path.length || byCodePoint(a.template.path, b.template.path);

/** The first `limit` of `ranked` in `byRank` order, kept in a list that long rather than by sorting every match. */
function firstPage(ranked: readonly Ranked[], limit: number): Ranked[] {
  const kept: Ranked[] = [];
  for (const candidate of ranked) {
    const last = kept.at(-1);
    if (kept.length === limit && (last === undefined || byRank(candidate, last) >= 0)) {
      continue;
    }
    let low = 0;
    let high = kept.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (byRank(kept[middle] as Ranked, candidate) <= 0) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    kept.splice(low, 0, candidate);
    if (kept.length > limit) {
      kept.pop();
    }
  }
  return kept;
}

export interface SearchResult {
  /** The best matches, best first, no more than the limit. */
  results: PreparedTemplate[];
  /** How many templates match in all. */
  total: number;
}

/**
 * The templates every word of `query` matches, in the name or the folder, best first: a name that starts with the
 * word, then one with a word starting with it, then one containing it, then a match on the folder alone. An entry
 * ranks as its worst-matched word. Ties go to the shorter path, then code-point order, so the list never reshuffles.
 * An empty query lists everything, in that order, within `folder` when one is given. Every match is counted but only
 * the page returned is put in order, since a short query matches most of the index.
 */
export function searchTemplates(
  prepared: readonly PreparedTemplate[],
  query: string,
  { folder, limit = DEFAULT_SEARCH_LIMIT }: { folder?: string; limit?: number } = {}
): SearchResult {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token !== "");
  const ranked: Ranked[] = [];
  for (const template of prepared) {
    if (folder !== undefined && template.folder !== folder) {
      continue;
    }
    let rank = 0;
    for (const token of tokens) {
      const matched = tokenRank(template, token);
      if (matched === undefined) {
        rank = -1;
        break;
      }
      rank = Math.max(rank, matched);
    }
    if (rank !== -1) {
      ranked.push({ template, rank });
    }
  }
  const page = Math.max(0, limit);
  const shown = ranked.length <= page ? ranked.sort(byRank) : firstPage(ranked, page);
  return { results: shown.map(({ template }) => template), total: ranked.length };
}

/** The folders the index has templates in, with how many each, in code-point order. A file at the top has none. */
export function folders(prepared: readonly PreparedTemplate[]): { folder: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const template of prepared) {
    if (template.folder !== "") {
      counts.set(template.folder, (counts.get(template.folder) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort(([a], [b]) => byCodePoint(a, b)).map(([folder, count]) => ({ folder, count }));
}
