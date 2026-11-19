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

const MIN_MATCH = 0.5;

function fieldsOf(file: string): string[] {
  const rows: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.flatMap((r: { ID?: unknown; FieldType?: unknown }) => (typeof r.ID === "string" && r.FieldType !== "Label" ? [r.ID] : []));
}

/** The case field ids of a CCD definition: a CaseField.json, or a directory holding CaseField.json or a CaseField folder of JSON files. */
export function loadCcdFields(path: string): string[] {
  if (!statSync(path).isDirectory()) {
    return fieldsOf(path);
  }
  const single = join(path, "CaseField.json");
  if (existsSync(single)) {
    return fieldsOf(single);
  }
  const folder = join(path, "CaseField");
  if (existsSync(folder)) {
    return readdirSync(folder)
      .filter((f) => f.endsWith(".json"))
      .sort(byCode)
      .flatMap((f) => fieldsOf(join(folder, f)));
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
