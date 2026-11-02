/**
 * Translation catalogues: one per service, at welsh/catalogue.csv in its home repo (see home.ts),
 * and nothing shared between services, because the right Welsh depends on where
 * it is used. Every row is Welsh supplied by the Welsh Language Unit — nothing in
 * this module creates Welsh text.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRecords, toCsv } from "./csv.ts";
import { welshDir } from "./home.ts";
import { hasVariants, looseKey, matchKey } from "./normalise.ts";

export const COLUMNS = ["id", "english", "welsh", "context", "notes", "source", "received", "status"] as const;

/**
 * Welsh answers to yes/no questions repeat the verb ("Ydw", "Oes", "Ydy"…), so a
 * catalogue "Yes" is only right for the question it was translated for.
 */
const CONTEXT_SENSITIVE = ["Yes", "No"];

/** Statuses a row can carry. Only `approved` rows are ever used to fill. */
export const STATUSES = ["approved", "superseded", "needs-review"] as const;

export function cataloguePath(service: string): string {
  return join(welshDir(service), "catalogue.csv");
}

export function rowId(english: string, context: string, welsh: string): string {
  return createHash("sha1")
    .update(`${matchKey(english)}\u0000${context.trim()}\u0000${welsh}`)
    .digest("hex")
    .slice(0, 10);
}

export function loadCatalogue(service: string): Catalogue {
  const path = cataloguePath(service);
  const rows = existsSync(path) ? (parseRecords(readFileSync(path, "utf8")) as unknown as Row[]) : [];
  return new Catalogue(service, path, rows);
}

export class Catalogue {
  readonly service: string;
  readonly path: string;
  readonly rows: Row[];
  private byKey = new Map<string, Row[]>();

  constructor(service: string, path: string, rows: Row[]) {
    this.service = service;
    this.path = path;
    this.rows = rows;
    for (const row of rows) {
      this.index(row);
    }
  }

  private index(row: Row): void {
    const key = matchKey(row.english);
    const list = this.byKey.get(key) ?? [];
    list.push(row);
    this.byKey.set(key, list);
  }

  /** Approved rows whose English matches exactly after normalisation. */
  approved(english: string): Row[] {
    return (this.byKey.get(matchKey(english)) ?? []).filter((r) => r.status === "approved");
  }

  /** Every row for this English, including superseded and needs-review. */
  history(english: string): Row[] {
    return this.byKey.get(matchKey(english)) ?? [];
  }

  /**
   * Add a row the WLU supplied. An existing approved row with the same English
   * and context but different Welsh is marked superseded. The same Welsh already
   * there is never a second row, since a row's id is its English, context and
   * Welsh: an approved one is left alone, and a needs-review or superseded one
   * takes the new status and source, so a WLU return confirms a row awaiting
   * review or brings back an earlier rendering. Returns what happened so callers
   * can report it.
   */
  add(input: NewRow): "added" | "unchanged" | "superseded-previous" {
    const context = input.context?.trim() ?? "";
    const status = input.status ?? "approved";
    const existing = this.history(input.english).filter((r) => r.context.trim() === context);
    const identical = existing.find((r) => r.welsh === input.welsh);
    if (identical && (identical.status === "approved" || identical.status === status)) {
      return "unchanged";
    }
    const same = status === "approved" ? existing.filter((r) => r.status === "approved" && r !== identical) : [];
    for (const r of same) {
      r.status = "superseded";
    }
    if (identical) {
      identical.status = status;
      identical.source = input.source;
      identical.received = input.received ?? new Date().toISOString().slice(0, 10);
      if (input.notes !== undefined) {
        identical.notes = input.notes;
      }
      return same.length ? "superseded-previous" : "added";
    }
    const row: Row = {
      id: rowId(input.english, context, input.welsh),
      english: input.english.trim(),
      welsh: input.welsh,
      context,
      notes: input.notes ?? "",
      source: input.source,
      received: input.received ?? new Date().toISOString().slice(0, 10),
      status
    };
    this.rows.push(row);
    this.index(row);
    return same.length ? "superseded-previous" : "added";
  }

  save(): void {
    writeFileSync(this.path, toCsv([[...COLUMNS], ...this.rows.map((r) => COLUMNS.map((c) => r[c] ?? ""))]));
  }
}

/**
 * Look one English string up in a service's catalogue.
 *
 *  - hit:       exactly one approved Welsh rendering, usable verbatim
 *  - ambiguous: more than one rendering, a cell holding variants, or English
 *               whose Welsh depends on context (Yes/No, plus `sensitive`) — a BA picks
 *  - miss:      nothing approved; `suggestions` are near matches for a human only
 */
export function lookup(english: string, catalogue: Catalogue, sensitive: string[] = []): Lookup {
  const contextual = [...CONTEXT_SENSITIVE, ...sensitive].map(looseKey).includes(looseKey(english));
  const rows = catalogue.approved(english);
  if (!rows.length) {
    return { kind: "miss", suggestions: suggest(english, catalogue, 3) };
  }
  const distinct = [...new Map(rows.map((r) => [r.welsh, r])).values()];
  if (distinct.length === 1 && !hasVariants(distinct[0].welsh) && !contextual) {
    return { kind: "hit", welsh: distinct[0].welsh, row: distinct[0], catalogue: catalogue.service };
  }
  return { kind: "ambiguous", options: distinct, catalogue: catalogue.service };
}

/** Near matches by loose key, then token overlap. For display only. */
export function suggest(english: string, catalogue: Catalogue, limit: number): Row[] {
  const loose = looseKey(english);
  const tokens = new Set(loose.split(/\W+/).filter((t) => t.length > 2));
  const scored: { row: Row; score: number }[] = [];
  for (const row of catalogue.rows) {
    if (row.status !== "approved") {
      continue;
    }
    const other = looseKey(row.english);
    let score = other === loose ? 1 : 0;
    if (!score && tokens.size) {
      const otherTokens = new Set(other.split(/\W+/).filter((t) => t.length > 2));
      const inBoth = [...tokens].filter((t) => otherTokens.has(t)).length;
      score = inBoth / Math.max(tokens.size, otherTokens.size);
    }
    if (score >= 0.5) {
      scored.push({ row, score });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.row);
}

export type SearchMode = "exact" | "contains" | "fuzzy";

/** Catalogue search for BAs. Shows needs-review rows (flagged by status); superseded only with includeAll. */
export function search(query: string, catalogue: Catalogue, mode: SearchMode, includeAll: boolean): SearchHit[] {
  // Search is for people, so it ignores case and trailing punctuation; lookup() does not.
  const q = looseKey(query);
  const hits: SearchHit[] = [];
  for (const row of catalogue.rows) {
    if (!includeAll && row.status === "superseded") {
      continue;
    }
    const sides: ["english" | "welsh", string][] = [
      ["english", row.english],
      ["welsh", row.welsh]
    ];
    for (const [side, text] of sides) {
      let score = 0;
      if (mode === "exact") {
        score = looseKey(text) === q ? 1 : 0;
      } else if (mode === "contains") {
        score = looseKey(text).includes(q) ? q.length / Math.max(looseKey(text).length, 1) : 0;
      } else {
        score = suggestScore(q, looseKey(text));
      }
      if (score > 0) {
        hits.push({ ...row, catalogue: catalogue.service, matchedOn: side, score: Number(score.toFixed(2)) });
        break;
      }
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}

function suggestScore(q: string, text: string): number {
  if (text.includes(q)) {
    return 0.9;
  }
  const qt = q.split(/\W+/).filter((t) => t.length > 2);
  if (!qt.length) {
    return 0;
  }
  const tt = new Set(text.split(/\W+/));
  const overlap = qt.filter((t) => tt.has(t)).length / qt.length;
  return overlap >= 0.5 ? overlap * 0.8 : 0;
}

export interface Row {
  id: string;
  english: string;
  welsh: string;
  context: string;
  notes: string;
  source: string;
  received: string;
  status: (typeof STATUSES)[number];
}

export interface NewRow {
  english: string;
  welsh: string;
  source: string;
  context?: string;
  notes?: string;
  received?: string;
  status?: Row["status"];
}

export type Lookup =
  | { kind: "hit"; welsh: string; row: Row; catalogue: string }
  | { kind: "ambiguous"; options: Row[]; catalogue: string }
  | { kind: "miss"; suggestions: Row[] };

export interface SearchHit extends Row {
  catalogue: string;
  matchedOn: "english" | "welsh";
  score: number;
}
