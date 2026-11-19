import type { DmnDecision, DmnDocument, DmnInput, DmnOutput } from "./dmn-model.ts";
import { isStructured, normaliseFeel, parseCell, parseExpr } from "./feel.ts";
import { fileNameOf, parseFileName } from "./file-names.ts";
import { generateDocument } from "./generator.ts";
import { type FileLayout, type Layout, layoutKey, layoutOf } from "./layout.ts";
import { byCodePoint, type Merged, majority, mergeSequences } from "./merge.ts";
import {
  AGGREGATIONS,
  type Cell,
  type Decision,
  type Dependency,
  type Expr,
  type Helper,
  HIT_POLICIES,
  type InputColumn,
  KINDS,
  type Kind,
  type OutputColumn,
  type Row,
  Spec,
  validateSpec
} from "./schema.ts";
import { keyedDecision, readDmnFile } from "./task-files.ts";

export interface DmnFile {
  name: string;
  xml: string;
}

export interface ImportOptions {
  jurisdiction?: string;
  serviceCode?: string;
  displayName?: string;
}

export interface RawFeelUse {
  kind: Kind;
  where: string;
  text: string;
  caseTypes: string[];
}

export interface ImportReport {
  files: Array<{ name: string; kind: Kind; caseType: string; rules: number; inputs: number; outputs: number; helpers: number }>;
  entries: Record<string, { total: number; structured: number; rawFeel: number }>;
  rawFeel: RawFeelUse[];
  /** Constructs the spec has no representation for. Anything listed here is lost by a round trip. */
  unrepresentable: Array<{ construct: string; count: number; files: string[] }>;
  /** Presentation the importer reads past and the generator recreates or discards. */
  presentation: Array<{ construct: string; count: number }>;
  notes: string[];
}

interface Table {
  caseType: string;
  decision: DmnDecision;
  helpers: DmnDecision[];
  document: DmnDocument;
}

function camel(text: string): string {
  const words = text.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.map((w, i) => w.charAt(0)[i === 0 ? "toLowerCase" : "toUpperCase"]() + w.slice(1)).join("");
}

/** A column's key: its variable, else its label in camel case, else `input`; a repeated key gets a number. */
function inputKeys(decision: DmnDecision): string[] {
  const stems = (decision.table?.inputs ?? []).map((input) => input.inputVariable || (input.label ? camel(input.label) : "") || "input");
  const keys = stems.map((stem, i) => (stems.indexOf(stem) === i ? stem : undefined));
  const taken = new Set(keys.filter((key): key is string => key !== undefined));
  return keys.map((key, i) => {
    if (key !== undefined) {
      return key;
    }
    let n = 2;
    while (taken.has(`${stems[i]}${n}`)) {
      n++;
    }
    taken.add(`${stems[i]}${n}`);
    return `${stems[i]}${n}`;
  });
}

/** An expression's text as the spec holds it: kept raw when the expression names a language other than FEEL. */
function parseText(text: string, language: string | undefined): Expr | undefined {
  return language !== undefined && language.toLowerCase() !== "feel" && text.trim() !== "" ? { feel: text.trim() } : parseExpr(text);
}

/** Counts one parsed entry, and records it when it fell back to raw FEEL. */
function addRaw(report: ImportReport, index: Map<string, RawFeelUse>, kind: Kind, where: string, parsed: Expr | Cell | undefined, caseType: string): void {
  const stats = report.entries[kind] ?? { total: 0, structured: 0, rawFeel: 0 };
  report.entries[kind] = stats;
  if (parsed === undefined) {
    return;
  }
  stats.total++;
  if (isStructured(parsed as Expr)) {
    stats.structured++;
    return;
  }
  stats.rawFeel++;
  const text = (parsed as { feel: string }).feel;
  const normalised = normaliseFeel(text);
  const key = `${kind}|${where}|${normalised}`;
  const existing = index.get(key);
  if (existing) {
    if (!existing.caseTypes.includes(caseType)) {
      existing.caseTypes.push(caseType);
    }
  } else {
    const use = { kind, where, text, caseTypes: [caseType] };
    index.set(key, use);
    report.rawFeel.push(use);
  }
}

function setOverride<V>(overrides: Record<string, Record<string, V>>, caseType: string, field: string, value: V): void {
  overrides[caseType] = { ...overrides[caseType], [field]: value };
}

function sameCaseTypes(subset: string[], all: string[]): string[] | undefined {
  return all.every((id) => subset.includes(id)) ? undefined : subset;
}

function pick<T>(values: Array<{ caseType: string; value: T | undefined }>): { base: T | undefined; overrides: Record<string, T | undefined> } {
  const { base, differing } = majority(values.map((v) => ({ caseType: v.caseType, value: v.value })));
  const overrides: Record<string, T | undefined> = {};
  for (const d of differing) {
    overrides[d.caseType] = d.value;
  }
  return { base, overrides };
}

/** The spec's name for each property of an input column, and the DMN model's. */
const INPUT_PROPERTIES = [
  ["label", "label"],
  ["variable", "inputVariable"],
  ["typeRef", "typeRef"],
  ["language", "expressionLanguage"],
  ["allowedValues", "allowedValues"]
] as const;

const HELPER_PROPERTIES = [
  ["typeRef", "typeRef"],
  ["language", "language"],
  ["historyTimeToLive", "historyTimeToLive"]
] as const;

const OUTPUT_PROPERTIES = [
  ["label", "label"],
  ["typeRef", "typeRef"]
] as const;

/** A column's properties as the commonest value among its case types, and what differs as per-case-type overrides. */
function columnProperties<S extends object>(
  perType: Array<{ caseType: string; source: S }>,
  properties: ReadonlyArray<readonly [string, keyof S]>
): { base: Record<string, unknown>; overrides: Record<string, Record<string, unknown>> } {
  const base: Record<string, unknown> = {};
  const overrides: Record<string, Record<string, unknown>> = {};
  for (const [field, from] of properties) {
    const picked = pick(perType.map(({ caseType, source }) => ({ caseType, value: source[from] as unknown })));
    if (picked.base !== undefined) {
      base[field] = picked.base;
    }
    for (const [caseType, value] of Object.entries(picked.overrides)) {
      setOverride(overrides, caseType, field, value ?? null);
    }
  }
  return { base, overrides };
}

/** One case type's decision table, from the file that holds it. */
interface Part {
  caseType: string;
  decision: DmnDecision;
}

/**
 * Merges the decision tables of one decision across case types: columns by key, rows shared where identical. `label` prefixes
 * the raw-FEEL locations, so a helper's table is told from the main one.
 */
function mergeTable(
  kind: Kind,
  label: string,
  parts: Part[],
  report: ImportReport,
  rawIndex: Map<string, RawFeelUse>
): { inputs: InputColumn[]; outputs: OutputColumn[]; rows: Row[]; hitPolicy: ReturnType<typeof pick<string>>; aggregation: ReturnType<typeof pick<string>> } {
  const caseTypes = parts.map((p) => p.caseType);
  for (const part of parts) {
    const names = (part.decision.table?.outputs ?? []).map((o) => o.name);
    const twice = names.find((name, i) => names.indexOf(name) !== i);
    if (twice !== undefined) {
      throw new Error(`${kind}: duplicate output name ${twice} in the table of ${label || part.caseType}${label ? ` for ${part.caseType}` : ""}`);
    }
  }
  const keysByCaseType = new Map(parts.map((p) => [p.caseType, inputKeys(p.decision)]));
  const partOf = new Map(parts.map((p) => [p.caseType, p]));

  // Columns: merged by key; each case type's own order is kept as a subsequence of the result.
  let inputOrder: Array<Merged<string>> = [];
  let outputOrder: Array<Merged<string>> = [];
  for (const part of parts) {
    inputOrder = mergeSequences(inputOrder, part.caseType, keysByCaseType.get(part.caseType) ?? [], (k) => k);
    outputOrder = mergeSequences(
      outputOrder,
      part.caseType,
      (part.decision.table?.outputs ?? []).map((o) => o.name),
      (k) => k
    );
  }
  for (const [label, order] of [
    ["input", inputOrder],
    ["output", outputOrder]
  ] as const) {
    const names = order.map((m) => m.item);
    const duplicate = names.find((name, i) => names.indexOf(name) !== i);
    if (duplicate !== undefined) {
      throw new Error(`${kind}: ${label} column ${duplicate} is in a different order in different case types, so one column list cannot serve them all`);
    }
  }

  const inputs: InputColumn[] = inputOrder.map(({ item: key, caseTypes: present }) => {
    const perType = present.map((caseType) => {
      const index = (keysByCaseType.get(caseType) ?? []).indexOf(key);
      return { caseType, source: (partOf.get(caseType) as Part).decision.table?.inputs[index] as NonNullable<DmnInput> };
    });
    const { base, overrides } = columnProperties(perType, INPUT_PROPERTIES);
    const expression = pick(
      perType.map(({ caseType, source }) => {
        const expr = parseText(source.expression, source.expressionLanguage);
        addRaw(report, rawIndex, kind, `${label}input ${key}`, expr, caseType);
        return { caseType, value: expr === undefined ? "" : JSON.stringify(expr) };
      })
    );
    for (const [caseType, value] of Object.entries(expression.overrides)) {
      setOverride(overrides, caseType, "expression", value === "" || value === undefined ? { feel: "" } : JSON.parse(value));
    }
    return {
      key,
      ...base,
      ...(expression.base === "" || expression.base === undefined ? {} : { expression: JSON.parse(expression.base) }),
      ...(sameCaseTypes(present, caseTypes) ? { only: present } : {}),
      ...(Object.keys(overrides).length > 0 ? { overrides } : {})
    } as InputColumn;
  });

  const outputs: OutputColumn[] = outputOrder.map(({ item: name, caseTypes: present }) => {
    const perType = present.map((caseType) => ({
      caseType,
      source: (partOf.get(caseType) as Part).decision.table?.outputs.find((o) => o.name === name) as NonNullable<DmnOutput>
    }));
    const { base, overrides } = columnProperties(perType, OUTPUT_PROPERTIES);
    return {
      name,
      ...base,
      ...(sameCaseTypes(present, caseTypes) ? { only: present } : {}),
      ...(Object.keys(overrides).length > 0 ? { overrides } : {})
    } as OutputColumn;
  });

  // Rows: shared across case types when identical once empty entries are dropped.
  const rowsOf = (part: Part): Row[] => {
    const keys = keysByCaseType.get(part.caseType) ?? [];
    const outputNames = (part.decision.table?.outputs ?? []).map((o) => o.name);
    return (part.decision.table?.rules ?? []).map((rule) => {
      const when: Record<string, Cell> = {};
      rule.inputs.forEach((text, index) => {
        const language = rule.inputLanguages?.[index];
        const cell = language ? { feel: text.trim(), language } : parseCell(text);
        if (cell !== undefined) {
          when[keys[index] as string] = cell;
          addRaw(report, rawIndex, kind, `${label}input ${keys[index]} entry`, cell, part.caseType);
        }
      });
      const returns: Record<string, Expr> = {};
      rule.outputs.forEach((text, index) => {
        const language = rule.outputLanguages?.[index];
        const expr = language ? { feel: text.trim(), language } : parseExpr(text);
        if (expr !== undefined) {
          returns[outputNames[index] as string] = expr;
          addRaw(report, rawIndex, kind, `${label}output ${outputNames[index]}`, expr, part.caseType);
        }
      });
      return {
        ...(rule.description ? { description: rule.description } : {}),
        ...(Object.keys(when).length > 0 ? { when } : {}),
        ...(Object.keys(returns).length > 0 ? { returns } : {})
      };
    });
  };
  const rowIdentity = (row: Row): string =>
    JSON.stringify(row, (_key, value) =>
      typeof value === "object" && value !== null && "feel" in value ? { ...value, feel: normaliseFeel(value.feel) } : value
    );
  let rowOrder: Array<Merged<Row>> = [];
  for (const part of parts) {
    rowOrder = mergeSequences(rowOrder, part.caseType, rowsOf(part), rowIdentity);
  }
  const rows: Row[] = rowOrder.map(({ item, caseTypes: present }) => {
    const only = sameCaseTypes(present, caseTypes);
    return {
      ...(item.description === undefined ? {} : { description: item.description }),
      ...(only ? { only } : {}),
      ...(item.when ? { when: item.when } : {}),
      ...(item.returns ? { returns: item.returns } : {})
    };
  });

  return {
    inputs,
    outputs,
    rows,
    hitPolicy: pick(parts.map((p) => ({ caseType: p.caseType, value: p.decision.table?.hitPolicy }))),
    aggregation: pick(parts.map((p) => ({ caseType: p.caseType, value: p.decision.table?.aggregation })))
  };
}

function importTables(kind: Kind, tables: Table[], allCaseTypes: string[], report: ImportReport, rawIndex: Map<string, RawFeelUse>): Decision {
  const caseTypes = tables.map((t) => t.caseType);
  const { inputs, outputs, rows, hitPolicy, aggregation } = mergeTable(
    kind,
    "",
    tables.map((t) => ({ caseType: t.caseType, decision: t.decision })),
    report,
    rawIndex
  );

  // Helper decisions and the dependencies between decisions.
  let helperOrder: Array<Merged<string>> = [];
  for (const table of tables) {
    helperOrder = mergeSequences(
      helperOrder,
      table.caseType,
      table.helpers.map((h) => h.name),
      (n) => n
    );
  }
  const helpers: Helper[] = helperOrder.map(({ item: name, caseTypes: present }) => {
    const perType = present.map((caseType) => {
      const table = tables.find((t) => t.caseType === caseType) as Table;
      return { caseType, helper: table.helpers.find((h) => h.name === name) as DmnDecision };
    });
    const { base, overrides } = columnProperties(
      perType.map(({ caseType, helper }) => ({
        caseType,
        source: { typeRef: helper.variable?.typeRef, language: helper.literal?.expressionLanguage, historyTimeToLive: helper.historyTimeToLive }
      })),
      HELPER_PROPERTIES
    );
    const variable = pick(
      perType.map(({ caseType, helper }) => ({
        caseType,
        value: helper.variable ? (helper.variable.name === name ? undefined : helper.variable.name) : (false as string | false | undefined)
      }))
    );
    const tableCount = perType.filter(({ helper }) => helper.table).length;
    if (tableCount > 0 && tableCount < perType.length) {
      throw new Error(`${kind}: helper ${name} is a decision table in some case types and a literal expression in others`);
    }
    const merged =
      tableCount > 0
        ? mergeTable(
            kind,
            `helper ${name} `,
            perType.map(({ caseType, helper }) => ({ caseType, decision: helper })),
            report,
            rawIndex
          )
        : undefined;
    const expression = pick(
      perType.map(({ caseType, helper }) => {
        const expr = merged ? undefined : parseText(helper.literal?.text ?? "", helper.literal?.expressionLanguage);
        if (!merged) {
          addRaw(report, rawIndex, kind, `helper ${name}`, expr, caseType);
        }
        return { caseType, value: JSON.stringify(expr === undefined ? { feel: "" } : expr) };
      })
    );
    if (merged) {
      for (const [caseType, value] of Object.entries(merged.hitPolicy.overrides)) {
        setOverride(overrides, caseType, "hitPolicy", value);
      }
      for (const [caseType, value] of Object.entries(merged.aggregation.overrides)) {
        setOverride(overrides, caseType, "aggregation", value ?? null);
      }
    } else {
      for (const [caseType, value] of Object.entries(expression.overrides)) {
        setOverride(overrides, caseType, "expression", JSON.parse(value ?? '{"feel":""}'));
      }
    }
    for (const [caseType, value] of Object.entries(variable.overrides)) {
      setOverride(overrides, caseType, "variable", value ?? null);
    }
    return {
      name,
      ...(variable.base === undefined ? {} : { variable: variable.base }),
      ...base,
      ...(merged
        ? {
            hitPolicy: merged.hitPolicy.base,
            ...(merged.aggregation.base ? { aggregation: merged.aggregation.base } : {}),
            inputs: merged.inputs,
            outputs: merged.outputs,
            rows: merged.rows
          }
        : { expression: JSON.parse(expression.base ?? '{"feel":""}') }),
      ...(sameCaseTypes(present, caseTypes) ? { only: present } : {}),
      ...(Object.keys(overrides).length > 0 ? { overrides } : {})
    } as Helper;
  });

  const edges: Array<{ dep: Dependency; caseTypes: string[] }> = [];
  for (const table of tables) {
    for (const decision of [table.decision, ...table.helpers]) {
      const from = decision === table.decision ? "table" : decision.name;
      for (const required of decision.requires) {
        const to = table.helpers.find((h) => h.id === required)?.name;
        if (to === undefined) {
          continue;
        }
        const edge = edges.find((e) => e.dep.decision === from && e.dep.requires === to);
        if (edge) {
          if (!edge.caseTypes.includes(table.caseType)) {
            edge.caseTypes.push(table.caseType);
          }
        } else {
          edges.push({ dep: { decision: from, requires: to }, caseTypes: [table.caseType] });
        }
      }
    }
  }
  const dependencies = edges.map(({ dep, caseTypes: present }) => ({ ...dep, ...(sameCaseTypes(present, caseTypes) ? { only: present } : {}) }));

  const name = pick(tables.map((t) => ({ caseType: t.caseType, value: t.decision.name })));
  const ttl = pick(tables.map((t) => ({ caseType: t.caseType, value: t.decision.historyTimeToLive })));
  const overrides: Record<string, Record<string, string | null>> = {};
  for (const [field, picked] of [
    ["name", name],
    ["hitPolicy", hitPolicy],
    ["aggregation", aggregation],
    ["historyTimeToLive", ttl]
  ] as const) {
    for (const [caseType, value] of Object.entries(picked.overrides)) {
      setOverride(overrides, caseType, field, value ?? null);
    }
  }
  return {
    ...(sameCaseTypes(caseTypes, allCaseTypes) ? { only: caseTypes } : {}),
    name: name.base as string,
    hitPolicy: hitPolicy.base as (typeof HIT_POLICIES)[number],
    ...(aggregation.base ? { aggregation: aggregation.base as (typeof AGGREGATIONS)[number] } : {}),
    ...(ttl.base === undefined ? {} : { historyTimeToLive: ttl.base }),
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    inputs,
    outputs,
    rows,
    ...(helpers.length > 0 ? { helpers } : {}),
    ...(dependencies.length > 0 ? { dependencies } : {})
  } as Decision;
}

/**
 * Builds one spec from every case type's DMNs of a service, and reports what could not be represented structurally.
 * The layout holds the ids, widths and diagram the spec leaves out; generating from both reproduces them.
 */
export function importDmns(files: DmnFile[], options: ImportOptions = {}): { spec: Spec; layout: Layout; report: ImportReport } {
  const report: ImportReport = { files: [], entries: {}, rawFeel: [], unrepresentable: [], presentation: [], notes: [] };
  const byKind = new Map<Kind, Table[]>();
  const rawIndex = new Map<string, RawFeelUse>();
  const slugs = new Map<string, string[]>();
  const parsedFiles = new Map<string, string>();
  const duplicates: string[] = [];
  const caseTypeOrder: string[] = [];
  const unrepresentable = new Map<string, { count: number; files: string[] }>();
  const presentation = new Map<string, number>();
  const parsed: Array<{ kind: Kind; caseType: string; document: DmnDocument; decision: DmnDecision; helpers: DmnDecision[]; fileName: string }> = [];
  const skipped: string[] = [];
  /** A file that is left out: noted, and, when it should have been a task DMN, flagged so the import does not pass. */
  const skip = (file: string, reason: string, flagged = false, construct = reason) => {
    report.notes.push(`${file}: ${reason}, skipped`);
    skipped.push(`${file}: ${reason}`);
    if (flagged) {
      flag(construct, file);
    }
  };
  const flag = (construct: string, file: string, count = 1) => {
    const entry = unrepresentable.get(construct) ?? { count: 0, files: [] };
    entry.count += count;
    entry.files.push(file);
    unrepresentable.set(construct, entry);
  };

  for (const file of [...files].sort((a, b) => byCodePoint(a.name, b.name))) {
    const byName = parseFileName(file.name);
    if (!byName && !(file.name.startsWith("wa-task-") && file.name.endsWith(".dmn"))) {
      skip(file.name, "not a wa-task-<kind>-<service>-<caseType>.dmn file");
      continue;
    }
    const { document, inspection } = readDmnFile(file.name, file.xml);
    const keyed = keyedDecision(document.decisions);
    const match = keyed ? parseFileName(`${keyed.id}.dmn`) : byName;
    if (!match) {
      skip(file.name, "a task DMN of a kind the spec does not know", true);
      continue;
    }
    const { kind, caseType } = match;
    const sameFile = parsedFiles.get(`${kind}/${caseType}`);
    if (sameFile) {
      slugs.set(match.service, [...(slugs.get(match.service) ?? []), file.name]);
      duplicates.push(`${sameFile} and ${file.name} are both the ${kind} DMN of ${caseType}`);
      continue;
    }
    parsedFiles.set(`${kind}/${caseType}`, file.name);
    const stem = file.name.replace(/\.dmn$/, "");
    const named = keyed ?? document.decisions.find((d) => d.id === stem);
    const decision = named ?? document.decisions.find((d) => d.table);
    if (!decision?.table) {
      skip(file.name, "no decision table found", true, "a task DMN with no decision table");
      continue;
    }
    const unnamed = decision.table.outputs.findIndex((output) => output.name === "");
    if (unnamed >= 0) {
      skip(file.name, "an output column has no name", true, `an output column without a name (column ${unnamed + 1})`);
      continue;
    }
    if (!HIT_POLICIES.includes(decision.table.hitPolicy as (typeof HIT_POLICIES)[number])) {
      skip(file.name, `hit policy ${decision.table.hitPolicy}`, true, `hit policy ${decision.table.hitPolicy}, which needs output values the spec cannot hold`);
      continue;
    }
    if (decision.table.aggregation && !AGGREGATIONS.includes(decision.table.aggregation as (typeof AGGREGATIONS)[number])) {
      skip(file.name, `aggregation ${decision.table.aggregation}`, true, `aggregation ${decision.table.aggregation}, which the spec does not know`);
      continue;
    }
    slugs.set(match.service, [...(slugs.get(match.service) ?? []), file.name]);
    if (!caseTypeOrder.includes(caseType)) {
      caseTypeOrder.push(caseType);
    }
    if (!named) {
      flag(`no decision has the file's key ${stem} as its id; the table ${decision.id} would be renamed to it`, file.name);
    }
    if (decision.variable) {
      flag(`the main decision ${decision.name} has a <variable>`, file.name);
    }
    const helpers: DmnDecision[] = [];
    const helperNames = new Set<string>();
    for (const helper of document.decisions.filter((d) => d !== decision)) {
      if (Boolean(helper.literal) === Boolean(helper.table)) {
        flag(`helper decision ${helper.name} is neither a literal expression nor a decision table`, file.name);
        continue;
      }
      if (helper.table && !HIT_POLICIES.includes(helper.table.hitPolicy as (typeof HIT_POLICIES)[number])) {
        flag(`hit policy ${helper.table.hitPolicy} of helper ${helper.name}, which needs output values the spec cannot hold`, file.name);
        continue;
      }
      if (helper.table?.outputs.some((output) => output.name === "")) {
        flag(`an output column without a name in helper ${helper.name}`, file.name);
        continue;
      }
      if (helper.name === "table") {
        flag("a helper decision named table, which the spec reserves for the main decision", file.name);
        continue;
      }
      if (helperNames.has(helper.name)) {
        flag(`more than one helper decision is named ${helper.name}`, file.name);
        continue;
      }
      if (helper.requires.includes(decision.id)) {
        flag(`helper ${helper.name} requires the main decision`, file.name);
      }
      helperNames.add(helper.name);
      helpers.push(helper);
    }
    const ids = new Set(document.decisions.map((d) => d.id));
    for (const d of document.decisions) {
      if (d.requires.some((required) => !ids.has(required))) {
        flag(`${d.name} requires a decision the file does not have`, file.name);
      }
    }
    if (document.name !== "DRD") {
      report.notes.push(`${file.name}: definitions name ${document.name} is replaced with DRD`);
    }
    for (const [construct, count] of inspection.unrepresentable) {
      flag(construct, file.name, count);
    }
    for (const [construct, count] of inspection.presentation) {
      presentation.set(construct, (presentation.get(construct) ?? 0) + count);
    }
    parsed.push({ kind, caseType, document, decision, helpers, fileName: file.name });
    byKind.set(kind, [...(byKind.get(kind) ?? []), { caseType, decision, helpers, document }]);
    report.files.push({
      name: file.name,
      kind,
      caseType,
      rules: decision.table.rules.length,
      inputs: decision.table.inputs.length,
      outputs: decision.table.outputs.length,
      helpers: helpers.length
    });
  }
  if (slugs.size > 1) {
    throw new Error(
      `The files name more than one service, and a spec holds one:\n${[...slugs].map(([slug, names]) => `  ${slug}: ${names.join(", ")}`).join("\n")}`
    );
  }

  if (byKind.size === 0) {
    throw new Error(`No task DMN could be imported${skipped.length > 0 ? `:\n${skipped.map((reason) => `  ${reason}`).join("\n")}` : ": none was given"}`);
  }
  if (duplicates.length > 0) {
    throw new Error(duplicates.join("\n"));
  }

  const decisions: Spec["decisions"] = {};
  for (const kind of KINDS) {
    const tables = byKind.get(kind);
    if (tables) {
      decisions[kind] = importTables(kind, tables, caseTypeOrder, report, rawIndex);
    }
  }
  const spec: Spec = {
    version: 1,
    service: {
      slug: [...slugs.keys()][0] ?? "service",
      ...(options.jurisdiction ? { jurisdiction: options.jurisdiction } : {}),
      ...(options.serviceCode ? { serviceCode: options.serviceCode } : {}),
      ...(options.displayName ? { displayName: options.displayName } : {})
    },
    caseTypes: caseTypeOrder.map((id) => ({ id })),
    decisions
  };
  const layouts: Record<string, FileLayout> = {};
  for (const { kind, caseType, document, decision, helpers, fileName } of parsed) {
    const layout = layoutOf(document, decision, helpers, inputKeys, generateDocument(spec, kind, caseType));
    layouts[layoutKey(kind, caseType)] = fileName === fileNameOf(spec.service.slug, kind, caseType) ? layout : { ...layout, fileName };
  }
  report.unrepresentable = [...unrepresentable].map(([construct, v]) => ({ construct, ...v }));
  report.presentation = [...presentation].map(([construct, count]) => ({ construct, count }));
  const problems = validateSpec(Spec.parse(spec));
  if (problems.length > 0) {
    throw new Error(`The import produced an invalid spec:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  }
  return { spec, layout: { version: 1, files: layouts }, report };
}

/** Renders the coverage report as Markdown. */
export function renderReport(report: ImportReport): string {
  const lines: string[] = ["# Import coverage", ""];
  lines.push(
    `${report.files.length} DMN files read.`,
    "",
    "## Entries by kind",
    "",
    "| Kind | Entries | Structured | Raw FEEL |",
    "| --- | ---: | ---: | ---: |"
  );
  for (const [kind, stats] of Object.entries(report.entries)) {
    lines.push(`| ${kind} | ${stats.total} | ${stats.structured} | ${stats.rawFeel} |`);
  }
  lines.push("", "## Unrepresentable", "");
  if (report.unrepresentable.length === 0) {
    lines.push("None. Every element and attribute that carries behaviour has a place in the spec.");
  }
  for (const item of report.unrepresentable) {
    lines.push(`- ${item.construct} (${item.count}, in ${item.files.join(", ")})`);
  }
  lines.push("", "## Presentation regenerated", "");
  for (const item of report.presentation) {
    lines.push(`- ${item.construct}: ${item.count}`);
  }
  lines.push("", "## Notes", "");
  if (report.notes.length === 0) {
    lines.push("None.");
  }
  for (const note of report.notes) {
    lines.push(`- ${note}`);
  }
  lines.push("", "## Raw FEEL fallbacks", "", "Represented as `{feel: ...}` because they are outside the structured expression forms.", "");
  for (const use of report.rawFeel) {
    const text = use.text.replace(/\s+/g, " ");
    lines.push(`- ${use.kind} ${use.where} [${use.caseTypes.join(", ")}]: \`${text.length > 140 ? `${text.slice(0, 140)}...` : text}\``);
  }
  lines.push("", "## Files", "", "| File | Rules | Inputs | Outputs | Helpers |", "| --- | ---: | ---: | ---: | ---: |");
  for (const file of report.files) {
    lines.push(`| ${file.name} | ${file.rules} | ${file.inputs} | ${file.outputs} | ${file.helpers} |`);
  }
  return `${lines.join("\n")}\n`;
}
