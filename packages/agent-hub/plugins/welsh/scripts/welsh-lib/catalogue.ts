/**
 * Translation catalogues: one per service at apps/<product>/welsh/catalogue.csv,
 * plus welsh/shared/catalogue.csv for common terms. Every row is Welsh supplied
 * by the Welsh Language Unit — nothing in this module creates Welsh text.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRecords, toCsv } from "./csv.ts";
import { hasVariants, looseKey, matchKey } from "./normalise.ts";
import { WORKSPACE } from "./paths.ts";

export const COLUMNS = ["id", "english", "welsh", "context", "notes", "source", "received", "status"] as const;

/**
 * Welsh answers to yes/no questions repeat the verb ("Ydw", "Oes", "Ydy"…), so a
 * catalogue "Yes" is only right for the question it was translated for.
 */
const CONTEXT_SENSITIVE = ["Yes", "No"];

/** Statuses a row can carry. Only `approved` rows are ever used to fill. */
export const STATUSES = ["approved", "superseded", "needs-review"] as const;

export function cataloguePath(service: string): string {
  return service === "shared" ? join(WORKSPACE, "welsh", "shared", "catalogue.csv") : join(WORKSPACE, "apps", service, "welsh", "catalogue.csv");
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

/** The service catalogue backed by the shared one. */
export function loadCatalogues(service: string): Catalogue[] {
  return service === "shared" ? [loadCatalogue("shared")] : [loadCatalogue(service), loadCatalogue("shared")];
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
   * and context but different Welsh is marked superseded; an identical row is
   * left alone. Returns what happened so callers can report it.
   */
  add(input: NewRow): "added" | "unchanged" | "superseded-previous" {
    const context = input.context?.trim() ?? "";
    const status = input.status ?? "approved";
    const existing = this.history(input.english).filter((r) => r.context.trim() === context);
    if (existing.some((r) => r.welsh === input.welsh && r.status !== "superseded")) {
      return "unchanged";
    }
    const same = status === "approved" ? existing.filter((r) => r.status === "approved") : [];
    for (const r of same) {
      r.status = "superseded";
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
 * Look one English string up, service catalogue first, then shared.
 *
 *  - hit:       exactly one approved Welsh rendering, usable verbatim
 *  - ambiguous: more than one rendering, a cell holding variants, or English
 *               whose Welsh depends on context (Yes/No, plus `sensitive`) — a BA picks
 *  - miss:      nothing approved; `suggestions` are near matches for a human only
 */
export function lookup(english: string, catalogues: Catalogue[], sensitive: string[] = []): Lookup {
  const contextual = [...CONTEXT_SENSITIVE, ...sensitive].map(looseKey).includes(looseKey(english));
  for (const cat of catalogues) {
    const rows = cat.approved(english);
    if (!rows.length) {
      continue;
    }
    const distinct = [...new Map(rows.map((r) => [r.welsh, r])).values()];
    if (distinct.length === 1 && !hasVariants(distinct[0].welsh) && !contextual) {
      return { kind: "hit", welsh: distinct[0].welsh, row: distinct[0], catalogue: cat.service };
    }
    return { kind: "ambiguous", options: distinct, catalogue: cat.service };
  }
  return { kind: "miss", suggestions: suggest(english, catalogues, 3) };
}

/** Near matches by loose key, then token overlap. For display only. */
export function suggest(english: string, catalogues: Catalogue[], limit: number): Row[] {
  const loose = looseKey(english);
  const tokens = new Set(loose.split(/\W+/).filter((t) => t.length > 2));
  const scored: { row: Row; score: number }[] = [];
  for (const cat of catalogues) {
    for (const row of cat.rows) {
      if (row.status !== "approved") {
        continue;
      }
      const other = looseKey(row.english);
      let score = other === loose ? 1 : 0;
      if (!score && tokens.size) {
        const otherTokens = new Set(other.split(/\W+/).filter((t) => t.length > 2));
        const shared = [...tokens].filter((t) => otherTokens.has(t)).length;
        score = shared / Math.max(tokens.size, otherTokens.size);
      }
      if (score >= 0.5) {
        scored.push({ row, score });
      }
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.row);
}

export type SearchMode = "exact" | "contains" | "fuzzy";

/** Catalogue search for BAs. Shows needs-review rows (flagged by status); superseded only with includeAll. */
export function search(query: string, catalogues: Catalogue[], mode: SearchMode, includeAll: boolean): SearchHit[] {
  // Search is for people, so it ignores case and trailing punctuation; lookup() does not.
  const q = looseKey(query);
  const hits: SearchHit[] = [];
  for (const cat of catalogues) {
    for (const row of cat.rows) {
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
          hits.push({ ...row, catalogue: cat.service, matchedOn: side, score: Number(score.toFixed(2)) });
          break;
        }
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
  const shared = qt.filter((t) => tt.has(t)).length / qt.length;
  return shared >= 0.5 ? shared * 0.8 : 0;
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
