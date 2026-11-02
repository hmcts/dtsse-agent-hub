/**
 * A spreadsheet the Welsh Language Unit sent back. Every row is checked
 * before any of its Welsh is used. A Ref is a hash of the service and the
 * English (contentRef), so recomputing it shows whether the English was
 * changed or the row belongs to another service — no ledger of past requests
 * is needed, which matters in a pod that keeps no files between restarts.
 */

import { contentRef } from "./requests.ts";
import { tokenProblems } from "./tokens.ts";
import { isPlaceholder } from "./verify.ts";
import { readTable } from "./xlsx.ts";

export async function readReturn(service: string, path: string): Promise<ReturnCheck> {
  const table = await readTable(path);
  const valid: ReturnRow[] = [];
  const blank: ReturnRow[] = [];
  const problems: ReturnProblem[] = [];

  for (const r of table.records) {
    const row: ReturnRow = { row: r.row, ref: r.fields.Ref ?? "", english: r.english, welsh: r.welsh };
    const issue = !row.ref
      ? "no Ref — rows must keep the Ref from the request"
      : !row.english.trim()
        ? "no English"
        : contentRef(service, row.english) !== row.ref
          ? `Ref ${row.ref} does not match this English for ${service} — the English was changed, or the row is from another request`
          : null;
    if (issue) {
      problems.push({ ...row, problem: issue });
      continue;
    }
    if (!row.welsh.trim()) {
      blank.push(row);
      continue;
    }
    if (isPlaceholder(row.welsh)) {
      problems.push({ ...row, problem: "Welsh is a placeholder, not a translation" });
      continue;
    }
    const tokens = tokenProblems(row.english, row.welsh);
    if (tokens.length) {
      problems.push({ ...row, problem: `placeholders do not match the English: ${tokens.join("; ")}` });
      continue;
    }
    valid.push(row);
  }
  return { sheet: table.sheet, valid, blank, problems };
}

export interface ReturnRow {
  row: number;
  ref: string;
  english: string;
  welsh: string;
}

export interface ReturnProblem extends ReturnRow {
  problem: string;
}

export interface ReturnCheck {
  sheet: string;
  valid: ReturnRow[];
  blank: ReturnRow[];
  problems: ReturnProblem[];
}
