import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CcdField } from "./ccd-match.ts";
import { readWorkbookBytes, rowTexts } from "./cells.ts";
import { byCode } from "./compare.ts";
import { unzipFiles } from "./unzip.ts";

/** The case fields of one CCD case type's definition. */
export interface CcdDefinition {
  /** The CaseTypeID the rows carry; absent when they are blank, as in a build made without the case type set. */
  caseType?: string;
  fields: CcdField[];
}

export interface CcdRow {
  ID?: unknown;
  Label?: unknown;
  FieldType?: unknown;
  FieldTypeParameter?: unknown;
  HintText?: unknown;
  CaseTypeID?: unknown;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** The rows as matching reads them, leaving out label fields and rows without an id. */
export function ccdFieldsOf(rows: CcdRow[]): CcdField[] {
  return rows.flatMap((r) =>
    typeof r.ID === "string" && r.ID !== "" && r.FieldType !== "Label"
      ? [
          {
            id: r.ID,
            label: str(r.Label),
            type: str(r.FieldType),
            ...(str(r.FieldTypeParameter) ? { typeParameter: str(r.FieldTypeParameter) } : {}),
            ...(str(r.HintText) ? { hint: str(r.HintText) } : {})
          }
        ]
      : []
  );
}

function rowsIn(text: string): CcdRow[] {
  const rows: unknown = JSON.parse(text);
  return Array.isArray(rows) ? (rows as CcdRow[]) : [];
}

/** The case field rows of a definition, with an ID of the form's case type (or every row when `caseType` is not given), leaving out label fields. */
export function ccdDefinitionOf(rows: CcdRow[], caseType?: string): CcdDefinition {
  const fields = rows.filter((r) => typeof r.ID === "string" && r.ID !== "");
  const ids = [...new Set(fields.flatMap((r) => (typeof r.CaseTypeID === "string" && r.CaseTypeID !== "" ? [r.CaseTypeID] : [])))].sort(byCode);
  const chosen = caseType ?? (ids.length === 1 ? ids[0] : undefined);
  if (chosen === undefined && ids.length > 1) {
    throw new Error(`that definition holds ${ids.length} case types (${ids.join(", ")}): give the case type id the form belongs to`);
  }
  const mine = chosen !== undefined && ids.includes(chosen) ? fields.filter((r) => r.CaseTypeID === chosen) : fields;
  return {
    ...(chosen ? { caseType: chosen } : {}),
    fields: ccdFieldsOf(mine)
  };
}

async function rowsOfWorkbook(bytes: Uint8Array): Promise<CcdRow[]> {
  const sheet = (await readWorkbookBytes(bytes)).getWorksheet("CaseField");
  if (!sheet) {
    throw new Error("that spreadsheet has no CaseField sheet");
  }
  for (let r = 1; r <= Math.min(sheet.rowCount, 6); r++) {
    const heads = rowTexts(sheet, r, sheet.columnCount);
    if (heads.includes("ID") && heads.includes("FieldType")) {
      return Array.from({ length: sheet.rowCount - r }, (_, n) => {
        const cells = rowTexts(sheet, r + 1 + n, heads.length);
        return Object.fromEntries(heads.map((h, i) => [h, cells[i]]));
      });
    }
  }
  throw new Error("the CaseField sheet has no ID and FieldType columns");
}

const isCaseFieldEntry = (path: string): boolean => /(^|\/)CaseField(\.json|\/[^/]+\.json)$/.test(path);

/**
 * A CCD definition from an upload: a CaseField.json, a zip of a definitions folder (CaseField.json or a CaseField folder at any depth) or a
 * definition spreadsheet. A zip of several case types needs `caseType` to say which.
 */
export async function readCcdDefinition(bytes: Uint8Array, caseType?: string): Promise<CcdDefinition> {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const entries = unzipFiles(bytes, isCaseFieldEntry);
    if (entries.length > 0) {
      const decoder = new TextDecoder();
      return ccdDefinitionOf(
        entries.sort((a, b) => byCode(a.path, b.path)).flatMap((e) => rowsIn(decoder.decode(e.content))),
        caseType
      );
    }
    return ccdDefinitionOf(await rowsOfWorkbook(bytes), caseType);
  }
  try {
    return ccdDefinitionOf(rowsIn(new TextDecoder().decode(bytes)), caseType);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("that is not a CaseField.json, a zip of a definitions folder or a definition spreadsheet");
    }
    throw error;
  }
}

/** The definition at a path: a CaseField.json or other definition file, or a directory holding CaseField.json or a CaseField folder of JSON files. */
export async function loadCcdDefinition(path: string, caseType?: string): Promise<CcdDefinition> {
  if (!statSync(path).isDirectory()) {
    return await readCcdDefinition(new Uint8Array(readFileSync(path)), caseType);
  }
  const single = join(path, "CaseField.json");
  if (existsSync(single)) {
    return ccdDefinitionOf(rowsIn(readFileSync(single, "utf8")), caseType);
  }
  const folder = join(path, "CaseField");
  if (existsSync(folder)) {
    const files = readdirSync(folder)
      .filter((f) => f.endsWith(".json"))
      .sort(byCode);
    return ccdDefinitionOf(
      files.flatMap((f) => rowsIn(readFileSync(join(folder, f), "utf8"))),
      caseType
    );
  }
  throw new Error(`no CaseField.json or CaseField folder in ${path}`);
}
