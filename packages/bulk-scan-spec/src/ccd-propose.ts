import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { byCode } from "./compare.ts";
import type { Confidence } from "./similarity.ts";
import { assign, confidenceOf, tokens } from "./similarity.ts";

export interface ProposedCcd {
  id: string;
  reason: string;
  confidence: Confidence;
}

/** The case fields of one CCD case type's definition. */
export interface CcdDefinition {
  /** The CaseTypeID the rows carry; absent when they are blank, as in a build made without the case type set. */
  caseType?: string;
  fields: string[];
}

export interface CcdRow {
  ID?: unknown;
  FieldType?: unknown;
  CaseTypeID?: unknown;
}

const MIN_MATCH = 0.5;

/** The case field rows of a definition: ids of the form's case type (or of every row when `caseType` is not given), leaving out label fields. Refuses rows that are not case fields. */
export function ccdDefinitionOf(rows: unknown, caseType?: string): CcdDefinition {
  if (!Array.isArray(rows)) {
    throw new Error(`that definition is a JSON ${rows === null ? "null" : typeof rows}, not a list of case fields`);
  }
  const bad = rows.find((r) => typeof r?.ID !== "string" || typeof r?.FieldType !== "string");
  if (bad !== undefined) {
    const has = bad && typeof bad === "object" ? Object.keys(bad).sort(byCode).join(", ") : typeof bad;
    throw new Error(`that definition is not a CaseField list: its rows have no ID and FieldType (they have ${has})`);
  }
  const fields = (rows as CcdRow[]).filter((r) => r.ID !== "");
  const ids = [...new Set(fields.flatMap((r) => (typeof r.CaseTypeID === "string" && r.CaseTypeID !== "" ? [r.CaseTypeID] : [])))].sort(byCode);
  if (caseType !== undefined && ids.length > 0 && !ids.includes(caseType)) {
    throw new Error(`that definition has no case type "${caseType}": it holds ${ids.join(", ")}`);
  }
  const chosen = caseType ?? (ids.length === 1 ? ids[0] : undefined);
  if (chosen === undefined && ids.length > 1) {
    throw new Error(`that definition holds ${ids.length} case types (${ids.join(", ")}): give the case type id the form belongs to`);
  }
  const mine = chosen !== undefined && ids.includes(chosen) ? fields.filter((r) => r.CaseTypeID === chosen) : fields;
  return {
    ...(chosen ? { caseType: chosen } : {}),
    fields: mine.flatMap((r) => (r.FieldType !== "Label" ? [r.ID as string] : []))
  };
}

function rowsIn(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${path} is not valid JSON`);
    }
    throw error;
  }
}

/** The definition at a path: a CaseField.json, or a directory holding CaseField.json or a CaseField folder of JSON files. */
export function loadCcdDefinition(path: string, caseType?: string): CcdDefinition {
  const file = statSync(path).isDirectory() ? join(path, "CaseField.json") : path;
  if (!statSync(path).isDirectory() || existsSync(file)) {
    return ccdDefinitionOf(rowsIn(file), caseType);
  }
  const folder = join(path, "CaseField");
  if (existsSync(folder)) {
    const files = readdirSync(folder)
      .filter((f) => f.endsWith(".json"))
      .sort(byCode);
    return ccdDefinitionOf(
      files.flatMap((f) => {
        const rows = rowsIn(join(folder, f));
        return Array.isArray(rows) ? rows : [rows];
      }),
      caseType
    );
  }
  throw new Error(`no CaseField.json or CaseField folder in ${path}`);
}

/** The CCD field whose id best matches each context, or nothing when none is close enough. A CCD field may serve several contexts, as an address does. */
export function proposeCcd(contexts: string[], fields: string[]): (ProposedCcd | undefined)[] {
  const found = assign(
    contexts.map((c) => ({ context: tokens(c) })),
    fields.map((id) => ({ id, words: tokens(id) })),
    MIN_MATCH,
    false
  );
  return contexts.map((_, i) => {
    const m = found.get(i);
    return m ? { id: m.candidate, reason: `closest CCD field id by wording (similarity ${m.score.toFixed(2)})`, confidence: confidenceOf(m.score) } : undefined;
  });
}
