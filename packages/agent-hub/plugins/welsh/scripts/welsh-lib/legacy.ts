/**
 * Seed a service catalogue from catalogues that pre-date this tooling: a WLU
 * spreadsheet (English | Welsh) and/or a flat JSON map { english: welsh }.
 *
 * Spreadsheets are the WLU's own text, so when both have an English string
 * the spreadsheet wins and the JSON copy is dropped. Disagreements inside a
 * source are never resolved here: every candidate is kept as `needs-review`
 * and reported for a BA to settle with the WLU.
 */

import { readFileSync } from "node:fs";
import type { Catalogue } from "./catalogue.ts";
import { matchKey, sameWelsh, splitLegacyEnglish } from "./normalise.ts";
import { readTable } from "./xlsx.ts";

export async function importLegacy(cat: Catalogue, sources: LegacySource[], received: string): Promise<LegacyReport> {
  const candidates: Candidate[] = [];
  for (const src of sources) {
    if (src.kind === "xlsx") {
      const table = await readTable(src.path);
      for (const rec of table.records) {
        if (!rec.english || !rec.welsh) {
          continue;
        }
        const { english, context } = splitLegacyEnglish(rec.english);
        candidates.push({ english, welsh: rec.welsh, context, source: src.label, where: `${src.label} row ${rec.row}`, rank: 0 });
      }
    } else {
      const map = JSON.parse(readFileSync(src.path, "utf8")) as Record<string, string>;
      for (const [en, cy] of Object.entries(map)) {
        if (!en || !cy) {
          continue;
        }
        const { english, context } = splitLegacyEnglish(en);
        candidates.push({ english, welsh: cy, context, source: src.label, where: `${src.label} "${en.slice(0, 40)}"`, rank: 1 });
      }
    }
  }

  // Group by English + context; within a group collapse renderings that are the same Welsh.
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = `${matchKey(c.english)}\u0000${c.context}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }

  const report: LegacyReport = { read: candidates.length, added: 0, unchanged: 0, overriddenCopies: 0, needsReview: 0, conflicts: [] };
  for (const group of groups.values()) {
    // A spreadsheet is the WLU's own text; a JSON map is a copy of it. When the
    // spreadsheet has the English, its rendering wins and the copy is dropped.
    const best = Math.min(...group.map((c) => c.rank));
    const kept = group.filter((c) => c.rank === best);
    report.overriddenCopies += group.length - kept.length;

    const renderings: Candidate[] = [];
    for (const c of kept) {
      if (!renderings.some((r) => sameWelsh(r.welsh, c.welsh))) {
        renderings.push(c);
      }
    }
    const conflict = renderings.length > 1;
    for (const r of renderings) {
      const sourcesFor = kept.filter((c) => sameWelsh(c.welsh, r.welsh)).map((c) => c.source);
      const reason = conflict
        ? "Legacy catalogue has more than one Welsh rendering — confirm with the WLU, then set one row approved"
        : best > 0
          ? "Only in a JSON copy, not the WLU spreadsheet — confirm with the WLU before use"
          : unbalancedQuotes(r.welsh) || unbalancedQuotes(r.english)
            ? "Stray quotation mark in the legacy cell — confirm the exact text with the WLU"
            : "";
      const outcome = cat.add({
        english: r.english,
        welsh: r.welsh,
        context: r.context,
        source: [...new Set(sourcesFor)].join("+"),
        received,
        status: reason ? "needs-review" : "approved",
        notes: reason
      });
      if (outcome === "unchanged") {
        report.unchanged++;
      } else {
        report.added++;
      }
      if (reason) {
        report.needsReview++;
      }
    }
    if (conflict) {
      report.conflicts.push({
        english: renderings[0].english,
        context: renderings[0].context,
        options: renderings.map((r) => ({ welsh: r.welsh, where: r.where }))
      });
    }
  }
  return report;
}

function unbalancedQuotes(text: string): boolean {
  return (text.match(/["“”]/g) ?? []).length % 2 === 1;
}

export type LegacySource = { kind: "xlsx" | "json"; path: string; label: string };

interface Candidate {
  english: string;
  welsh: string;
  context: string;
  source: string;
  where: string;
  rank: number;
}

export interface LegacyReport {
  read: number;
  added: number;
  unchanged: number;
  /** JSON copies dropped because the spreadsheet had the same English. */
  overriddenCopies: number;
  needsReview: number;
  conflicts: { english: string; context: string; options: { welsh: string; where: string }[] }[];
}
