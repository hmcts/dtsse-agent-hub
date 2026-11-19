import type ExcelJS from "exceljs";
import { columnLetters, rowTexts } from "./cells.ts";
import { byCode } from "./compare.ts";
import { parseEmits } from "./emits.ts";
import type { LogicContext } from "./logic.ts";
import { parseLogic } from "./logic.ts";
import type { Compose, Field, FormSpec, Section, TransformColumn } from "./schema.ts";
import { fieldSchema, formSpecSchema, TRANSFORM_COLUMNS } from "./schema.ts";

export interface UnparsedRow {
  row: number;
  id: string;
  keys: string[];
  reason: string;
}

export interface TransformImport {
  spec: FormSpec;
  /** Logic cells with content that no rule captures. Compose rows count as captured when the sheet's logic is only the address-mapping sentence. */
  unparsed: UnparsedRow[];
  logicRows: number;
  /** Tag Name tokens that are not keys (and not separators), with where they were, so none is dropped silently. */
  rejectedTokens: { row: number; column: TransformColumn; token: string }[];
  /** "Optional/Mandatory if …" conditions that could not be tied to one of the form's keys. */
  unresolvedConditions: { row: number; label: string }[];
  parsedRows: number;
  /** Rows turned into rules in which some conditions or actions stay as English (`rule.action`), each with a TODO on the field. */
  partialRows: number;
}

const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;
const PART_NAMES: Record<string, string> = {
  BuildingAndStreet: "AddressLine1",
  SecondLineOfAddress: "AddressLine2",
  TownOrCity: "PostTown",
  County: "County",
  Postcode: "PostCode",
  Country: "Country"
};

function parseKeys(text: string, rejected: string[]): string[] {
  const keys: string[] = [];
  for (const line of text.split("\n")) {
    const token = line.replace(/^\s*[a-z]\)\s*/, "").trim();
    if (IDENT.test(token) && token !== "NA") {
      keys.push(token);
    } else if (token !== "" && token !== "NA" && !/^-+$/.test(token)) {
      rejected.push(token);
    }
  }
  return keys;
}

/** The CCD ids of a CCD cell: a bare id, or the id of an "id: value" line (whose line is also kept as a note). Every other line is a note. */
function parseCcd(text: string): { ids: string[]; note?: string } {
  const ids: string[] = [];
  const notes: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const assigned = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*\S/.exec(trimmed)?.[1];
    if (IDENT.test(trimmed)) {
      ids.push(trimmed);
    } else if (trimmed) {
      notes.push(trimmed);
      if (assigned && !ids.includes(assigned)) {
        ids.push(assigned);
      }
    }
  }
  return { ids, note: notes.length > 0 ? notes.join("\n") : undefined };
}

function parseMandatory(text: string): Field["mandatory"] {
  const t = text.trim().toLowerCase();
  if (t === "mandatory") {
    return "mandatory";
  }
  if (t === "optional") {
    return "optional";
  }
  if (t === "do not read") {
    return "not-read";
  }
  if (t.startsWith("optional/mandatory")) {
    return "conditional";
  }
  return "optional";
}

function optionLabels(label: string): string[] {
  return label
    .split("\n")
    .map((l) => /^\s*\[\]\s*(.*)$/.exec(l)?.[1]?.trim())
    .filter((l): l is string => !!l);
}

function partName(key: string, prefix: string): string {
  const suffix = key.toLowerCase().startsWith(prefix.toLowerCase()) ? key.slice(prefix.length) : key;
  return PART_NAMES[suffix] ?? (suffix || key);
}

/**
 * The part of the keys they share, up to a word boundary: case is ignored while matching, and the prefix backs off to the last
 * capital only when it stops in the middle of a word of some key.
 */
function commonPrefix(keys: string[]): string {
  const first = keys[0] ?? "";
  let n = first.length;
  for (const k of keys) {
    while (n > 0 && k.slice(0, n).toLowerCase() !== first.slice(0, n).toLowerCase()) {
      n--;
    }
  }
  const atBoundary = keys.every((k) => k.length === n || /[A-Z0-9]/.test(k.charAt(n)));
  if (atBoundary) {
    return first.slice(0, n);
  }
  const boundary = first.slice(0, n).search(/[A-Z][a-z]*$/);
  return boundary > 0 ? first.slice(0, boundary) : "";
}

/**
 * Rows that feed one CCD field are a compose only when the sheet says so: it merged their CCD cell, or they are recognisable address
 * parts. Rows that merely happen to share a CCD field (two options mapping to one value) are separate.
 */
function detectComposes(fields: Field[], evidence: (run: Field[]) => boolean): Compose[] {
  const composes: Compose[] = [];
  let run: Field[] = [];
  const flush = () => {
    const ccd = run[0]?.ccd[0];
    if (run.length > 1 && ccd && evidence(run)) {
      const keys = run.flatMap((f) => f.keys);
      const prefix = commonPrefix(keys);
      composes.push({
        ccd,
        type: /Address$/.test(ccd) ? "AddressUK" : undefined,
        from: Object.fromEntries(keys.map((k) => [partName(k, prefix), k]))
      });
    }
    run = [];
  };
  for (const f of fields) {
    const sameRun = f.role === "field" && f.keys.length === 1 && f.ccd.length === 1 && run[0]?.ccd[0] === f.ccd[0];
    if (!sameRun) {
      flush();
    }
    if (f.role === "field" && f.keys.length === 1 && f.ccd.length === 1) {
      run.push(f);
    }
  }
  flush();
  for (const f of fields) {
    const [ccd] = f.ccd;
    if (f.role === "field" && f.inputType === "date" && f.keys.length === 3 && f.ccd.length === 1 && ccd) {
      const part = (suffix: string) => f.keys.find((k) => k.endsWith(suffix));
      const [day, month, year] = [part("Day"), part("Month"), part("Year")];
      if (day && month && year) {
        composes.push({ ccd, type: "Date", from: { Day: day, Month: month, Year: year } });
      }
    }
  }
  return composes;
}

/** The keys of the question above a field and the questions below it, which the sheet's logic refers to as "(field above)" and "(below)". */
function neighbours(fields: Field[], index: number): Pick<LogicContext, "aboveKeys" | "belowFields"> {
  const readable = (f: Field | undefined) => f?.role === "field" && f.keys.length > 0;
  const above = fields
    .slice(0, index)
    .reverse()
    .find((f) => readable(f));
  const below = fields
    .slice(index + 1)
    .filter(readable)
    .slice(0, 6)
    .map((f) => ({ keys: f.keys, label: f.label.split("\n")[0] ?? "" }));
  return { aboveKeys: above?.keys, belowFields: below };
}

function conditionalRequired(text: string): Field["required"] {
  const m = /^\s*Optional\/Mandatory if\s+(.+?)\s*$/i.exec(text);
  return m?.[1] ? { label: m[1] } : undefined;
}

/**
 * The key a condition such as "Joint app" stands for: the shortest key containing its first meaningful word, when that is unique
 * by length. Anything less certain is left unresolved for a person to settle.
 */
function resolveCondition(label: string, keys: string[]): Record<string, { ticked: boolean }> | undefined {
  const word = label
    .toLowerCase()
    .split(/\W+/)
    .find((w) => w.length > 2 && !["app", "the", "and"].includes(w));
  if (!word) {
    return undefined;
  }
  const hits = keys.filter((k) => k.toLowerCase().includes(word)).sort((a, b) => a.length - b.length || byCode(a, b));
  const [best, next] = hits;
  return best && (!next || best.length < next.length) ? { [best]: { ticked: true } } : undefined;
}

function readRow(texts: string[], rejected: string[]): Field {
  const [
    id = "",
    label = "",
    dataType = "",
    mandatory = "",
    validation = "",
    defaultValue = "",
    description = "",
    tagName = "",
    comments = "",
    ccd = "",
    _logic = "",
    _casePath = ""
  ] = texts;
  const type = dataType.trim().toLowerCase();
  const xor = /^xor\s*\((\d+)\)/.exec(type);
  const keys = parseKeys(tagName, rejected);
  const mandatoryKind = parseMandatory(mandatory);
  const isQr = id.trim().toLowerCase() === "qr code" || type === "qr code";
  // A Do not read row with keys is still a field the SIP lists; one with none is a heading or a spacer.
  const role: Field["role"] = isQr ? "qr" : mandatoryKind === "not-read" && keys.length === 0 ? "label" : "field";
  const inputType: Field["inputType"] = xor
    ? "checkbox"
    : isQr
      ? "qr"
      : type === "date"
        ? "date"
        : role === "label" || mandatoryKind === "not-read"
          ? "none"
          : "text";
  const emitted = parseEmits(description);
  const parsedCcd = parseCcd(ccd);
  const labels = optionLabels(label);
  const group: Field["group"] = xor
    ? {
        kind: "xor",
        size: Number(xor[1]),
        options: keys.map((key, i) => ({ key, label: labels.length === keys.length ? labels[i] : undefined }))
      }
    : undefined;
  return fieldSchema.parse({
    id: id || undefined,
    role,
    label,
    inputType,
    mandatory: mandatoryKind,
    group,
    keys,
    ccd: parsedCcd.ids,
    ccdNote: parsedCcd.note,
    validationRule: validation && validation !== "NA" ? validation : undefined,
    defaultValue: defaultValue && defaultValue !== "NA" ? defaultValue : undefined,
    businessRules: comments || undefined,
    emits: role === "field" && mandatoryKind !== "not-read" && emitted.length > 0 ? emitted : undefined,
    required: conditionalRequired(mandatory)
  });
}

/** Reads a D8-style transformation sheet (twelve columns, one row per OCR field) into a form spec. */
export function importTransformSheet(sheet: ExcelJS.Worksheet, formType?: string): TransformImport {
  const name = formType ?? sheet.name.replace(/\s*BSS\s*$/i, "").trim();
  const sections: Section[] = [{ id: "0", title: "", fields: [] }];
  const unparsed: UnparsedRow[] = [];
  const raws: { field: Field; row: number; texts: string[] }[] = [];
  const rejectedTokens: TransformImport["rejectedTokens"] = [];
  const unresolvedConditions: TransformImport["unresolvedConditions"] = [];
  let logicRows = 0;
  let parsedRows = 0;
  let partialRows = 0;

  for (let r = 2; r <= sheet.rowCount; r++) {
    const texts = rowTexts(sheet, r, TRANSFORM_COLUMNS.length);
    if (texts.every((t) => t === "")) {
      // A spacer row stays in the spec so that every later row keeps its place.
      sections.at(-1)?.fields.push(fieldSchema.parse({ role: "blank", mandatory: "not-read", inputType: "none" }));
      raws.push({ field: sections.at(-1)?.fields.at(-1) as Field, row: r, texts });
      continue;
    }
    const rejected: string[] = [];
    const field = readRow(texts, rejected);
    rejectedTokens.push(...rejected.map((token) => ({ row: r, column: "tagName" as const, token })));
    const heading = field.role === "label" ? /^\s*Section\s+(\d+)/i.exec(field.label) : null;
    if (heading?.[1]) {
      sections.push({ id: heading[1], title: field.label, heading: field, fields: [] });
    } else {
      sections.at(-1)?.fields.push(field);
    }
    raws.push({ field, row: r, texts });
  }

  const all = sections.flatMap((s) => s.fields);
  const ccdColumn = columnLetters(TRANSFORM_COLUMNS.indexOf("ccd") + 1);
  const rowOf = new Map(raws.map((r) => [r.field, r.row]));
  const merged = sheet.model.merges.flatMap((m) => {
    const range = new RegExp(`^${ccdColumn}(\\d+):${ccdColumn}(\\d+)$`).exec(m);
    return range ? [{ from: Number(range[1]), to: Number(range[2]) }] : [];
  });
  const composes = detectComposes(all, (run) => {
    const first = rowOf.get(run[0] as Field) ?? 0;
    const last = rowOf.get(run.at(-1) as Field) ?? 0;
    const addressParts = /Address$/.test(run[0]?.ccd[0] ?? "") && run.filter((f) => Object.keys(PART_NAMES).some((p) => f.keys[0]?.endsWith(p))).length > 1;
    return addressParts || merged.some((m) => m.from <= first && m.to >= last);
  });

  const allKeys = [...new Set(all.flatMap((f) => [...f.keys, ...(f.emits ?? []).map((e) => e.key)]))];
  const emittedKeys = [...new Set(all.flatMap((f) => (f.role === "field" && f.mandatory !== "not-read" ? f.keys : [])))];
  for (const { field, row } of raws) {
    if (field.required && !field.required.when) {
      const when = resolveCondition(
        field.required.label,
        emittedKeys.filter((k) => !field.keys.includes(k))
      );
      if (when) {
        field.required.when = when;
      } else {
        field.todo.push(`TODO: the condition "${field.required.label}" is not tied to a key`);
        unresolvedConditions.push({ row, label: field.required.label });
      }
    }
  }
  const ids = new Set(all.flatMap((f) => (f.id ? [f.id] : [])));
  const orderedFields = raws.map((r) => r.field);
  for (const [index, { field, row, texts }] of raws.entries()) {
    const logic = texts[10] ?? "";
    const casePath = texts[11] ?? "";
    if (field.role === "field") {
      const described = [...new Set((field.emits ?? []).map((e) => e.key))];
      const parse = parseLogic(logic, casePath, {
        keys: [...new Set([...field.keys, ...described])],
        ccd: field.ccd,
        knowsId: (id) => ids.has(id),
        allKeys,
        ...neighbours(orderedFields, index)
      });
      field.neverExceeds = parse.neverExceeds;
      if (logic.trim()) {
        logicRows++;
        const addressOnly = composes.some((c) => field.ccd.includes(c.ccd)) && /^Populate these separate address fields/i.test(logic.trim());
        if (parse.parsed) {
          field.rules = parse.rules;
          field.logicPreamble = parse.preamble;
          if (parse.fragments > 0) {
            partialRows++;
            field.todo.push(`TODO: ${parse.fragments} English fragment(s) in the logic are kept as text (rule.action)`);
          } else {
            parsedRows++;
          }
        } else if (addressOnly) {
          parsedRows++;
        } else {
          field.logicText = logic;
          field.todo.push(`TODO: logic not parsed into rules (${parse.reason})`);
          unparsed.push({ row, id: field.id ?? "", keys: field.keys, reason: parse.reason });
        }
      }
      // What the case path says beyond each branch's outcome and the "cannot go into" trailer; with no rules, everything but the trailer.
      const paragraphs = casePath
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter((p) => p && !/^Record cannot go into/i.test(p));
      const kept = field.rules.length > 0 ? paragraphs.filter((p) => !/^\d+[a-z]?\)?\s*=?\s*(success|warning|exception)/i.test(p)) : paragraphs;
      field.casePathNote = kept.length > 0 ? kept.join("\n\n") : undefined;
    } else if (logic || casePath) {
      field.logicText = logic;
      field.casePathNote = casePath;
    }
  }

  const spec = formSpecSchema.parse({
    form: { name, formType: name },
    sections: sections.filter((s) => s.heading || s.fields.length > 0),
    composes
  });
  return { spec, unparsed, logicRows, rejectedTokens, unresolvedConditions, parsedRows, partialRows };
}
