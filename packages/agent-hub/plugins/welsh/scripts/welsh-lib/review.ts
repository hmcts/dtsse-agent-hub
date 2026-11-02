/**
 * welsh/needs-review.md: every catalogue row a BA still has to settle with the
 * Welsh Language Unit, and why. It is rebuilt from the catalogue whenever rows
 * are added, so it is the one list to work through. A needs-review row is
 * never used to fill anything until a BA sets it approved (and any other
 * rendering of the same English superseded) once the WLU confirms it.
 */

import type { Catalogue, Row } from "./catalogue.ts";
import { matchKey } from "./normalise.ts";

export const REVIEW_FILE = "needs-review.md";

export function reviewMarkdown(catalogue: Catalogue): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
  const groups = new Map<string, Row[]>();
  for (const row of catalogue.rows) {
    if (row.status !== "needs-review") {
      continue;
    }
    const key = `${matchKey(row.english)}\u0000${row.context.trim()}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const lines = [
    `# Welsh to review — ${catalogue.service}`,
    "",
    `${groups.size} English string(s) have Welsh that is not used until a BA confirms it with the Welsh Language Unit.`,
    "For each, set the right row to `approved` in `catalogue.csv`, and any other rendering of the same English to `superseded`.",
    "A WLU return with the same Welsh approves the row by itself.",
    "",
    "| English | Context | Welsh (row id) | Why it needs review |",
    "|---|---|---|---|"
  ];
  const sorted = [...groups.values()].sort((a, b) => (a[0].english < b[0].english ? -1 : Number(a[0].english > b[0].english)));
  for (const rows of sorted) {
    const welsh = rows.map((r) => `${cell(r.welsh)} _(${r.id})_`).join("<br><br>");
    const why = [...new Set(rows.map((r) => r.notes.trim()).filter((n) => n !== ""))].map(cell).join("<br>");
    lines.push(`| ${cell(rows[0].english)} | ${cell(rows[0].context)} | ${welsh} | ${why} |`);
  }
  return `${lines.join("\n")}\n`;
}
