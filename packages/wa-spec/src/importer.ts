import { type DmnDecision, type DmnDocument, inspectDmn, parseDmn } from "./dmn-model.ts";
import { isStructured, normaliseFeel, parseCell, parseExpr } from "./feel.ts";
import { type Merged, majority, mergeSequences } from "./merge.ts";
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
  type Spec
} from "./schema.ts";

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

const FILE_PATTERN = /^wa-task-(initiation|configuration|permissions|completion|cancellation|types)-(.+)-([^-]+)\.dmn$/;

const KIND_OF_FILE: Record<string, Kind> = {
  initiation: "initiation",
  configuration: "configuration",
  permissions: "permissions",
  completion: "completion",
  cancellation: "cancellation",
  types: "task-types"
};

interface Table {
  caseType: string;
  decision: DmnDecision;
  helpers: DmnDecision[];
  document: DmnDocument;
}

function camel(text: string): string {
  const words = text.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1))).join("");
}

interface TableColumns {
  inputKeys: string[];
}

function inputKeys(decision: DmnDecision): TableColumns {
  const seen = new Map<string, number>();
  const keys = (decision.table?.inputs ?? []).map((input) => {
    const base = input.inputVariable ?? (input.label ? camel(input.label) : "") ?? "";
    const stem = base === "" ? "input" : base;
    const count = (seen.get(stem) ?? 0) + 1;
    seen.set(stem, count);
    return count === 1 ? stem : `${stem}${count}`;
  });
  return { inputKeys: keys };
}

/** Counts one parsed entry, and records it when it fell back to raw FEEL. */
function addRaw(report: ImportReport, kind: Kind, where: string, parsed: Expr | Cell | undefined, caseType: string): void {
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
  const existing = report.rawFeel.find((r) => r.kind === kind && r.where === where && normaliseFeel(r.text) === normalised);
  if (existing) {
    if (!existing.caseTypes.includes(caseType)) {
      existing.caseTypes.push(caseType);
    }
  } else {
    report.rawFeel.push({ kind, where, text, caseTypes: [caseType] });
  }
}

function setOverride<V>(overrides: Record<string, Record<string, V>>, caseType: string, field: string, value: V): void {
  overrides[caseType] = { ...overrides[caseType], [field]: value };
}

function sameCaseTypes(subset: string[], all: string[]): string[] | undefined {
  return subset.length === all.length ? undefined : subset;
}

function pick<T>(values: Array<{ caseType: string; value: T | undefined }>): { base: T | undefined; overrides: Record<string, T | undefined> } {
  const { base, differing } = majority(values.map((v) => ({ caseType: v.caseType, value: v.value })));
  const overrides: Record<string, T | undefined> = {};
  for (const d of differing) {
    overrides[d.caseType] = d.value;
  }
  return { base, overrides };
}

function importTables(kind: Kind, tables: Table[], allCaseTypes: string[], report: ImportReport): Decision {
  const caseTypes = tables.map((t) => t.caseType);
  const keysByCaseType = new Map(tables.map((t) => [t.caseType, inputKeys(t.decision).inputKeys]));

  // Columns: merged by key; each case type's own order is kept as a subsequence of the result.
  let inputOrder: Array<Merged<string>> = [];
  let outputOrder: Array<Merged<string>> = [];
  for (const table of tables) {
    inputOrder = mergeSequences(inputOrder, table.caseType, keysByCaseType.get(table.caseType) ?? [], (k) => k);
    outputOrder = mergeSequences(
      outputOrder,
      table.caseType,
      (table.decision.table?.outputs ?? []).map((o) => o.name),
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
      const table = tables.find((t) => t.caseType === caseType) as Table;
      const index = (keysByCaseType.get(caseType) ?? []).indexOf(key);
      const input = table.decision.table?.inputs[index];
      return { caseType, input: input as NonNullable<typeof input> };
    });
    const props = (field: "label" | "typeRef" | "inputVariable" | "expressionLanguage") =>
      pick(perType.map(({ caseType, input }) => ({ caseType, value: input[field] })));
    const label = props("label");
    const variable = props("inputVariable");
    const typeRef = props("typeRef");
    const language = props("expressionLanguage");
    const expression = pick(
      perType.map(({ caseType, input }) => {
        const expr = parseExpr(input.expression);
        addRaw(report, kind, `input ${key}`, expr, caseType);
        return { caseType, value: expr === undefined ? "" : JSON.stringify(expr) };
      })
    );
    const overrides: Record<string, Record<string, unknown>> = {};
    const put = (caseType: string, field: string, value: unknown) => setOverride(overrides, caseType, field, value);
    for (const [caseType, value] of Object.entries(label.overrides)) {
      put(caseType, "label", value ?? null);
    }
    for (const [caseType, value] of Object.entries(variable.overrides)) {
      put(caseType, "variable", value ?? null);
    }
    for (const [caseType, value] of Object.entries(typeRef.overrides)) {
      put(caseType, "typeRef", value ?? null);
    }
    for (const [caseType, value] of Object.entries(language.overrides)) {
      put(caseType, "language", value ?? null);
    }
    for (const [caseType, value] of Object.entries(expression.overrides)) {
      put(caseType, "expression", value === "" || value === undefined ? { feel: "" } : JSON.parse(value));
    }
    return {
      key,
      ...(label.base === undefined ? {} : { label: label.base }),
      ...(variable.base === undefined ? {} : { variable: variable.base }),
      ...(typeRef.base === undefined ? {} : { typeRef: typeRef.base }),
      ...(language.base === undefined ? {} : { language: language.base }),
      ...(expression.base === "" || expression.base === undefined ? {} : { expression: JSON.parse(expression.base) }),
      ...(sameCaseTypes(present, caseTypes) ? { only: present } : {}),
      ...(Object.keys(overrides).length > 0 ? { overrides } : {})
    } as InputColumn;
  });

  const outputs: OutputColumn[] = outputOrder.map(({ item: name, caseTypes: present }) => {
    const perType = present.map((caseType) => {
      const table = tables.find((t) => t.caseType === caseType) as Table;
      return { caseType, output: table.decision.table?.outputs.find((o) => o.name === name) as NonNullable<Table["decision"]["table"]>["outputs"][number] };
    });
    const label = pick(perType.map(({ caseType, output }) => ({ caseType, value: output.label })));
    const typeRef = pick(perType.map(({ caseType, output }) => ({ caseType, value: output.typeRef })));
    const overrides: Record<string, Record<string, unknown>> = {};
    for (const [caseType, value] of Object.entries(label.overrides)) {
      setOverride(overrides, caseType, "label", value ?? null);
    }
    for (const [caseType, value] of Object.entries(typeRef.overrides)) {
      setOverride(overrides, caseType, "typeRef", value ?? null);
    }
    return {
      name,
      ...(label.base === undefined ? {} : { label: label.base }),
      ...(typeRef.base === undefined ? {} : { typeRef: typeRef.base }),
      ...(sameCaseTypes(present, caseTypes) ? { only: present } : {}),
      ...(Object.keys(overrides).length > 0 ? { overrides } : {})
    } as OutputColumn;
  });

  // Rows: shared across case types when identical once empty entries are dropped.
  const rowsOf = (table: Table): Row[] => {
    const keys = keysByCaseType.get(table.caseType) ?? [];
    const outputNames = (table.decision.table?.outputs ?? []).map((o) => o.name);
    return (table.decision.table?.rules ?? []).map((rule) => {
      const when: Record<string, Cell> = {};
      rule.inputs.forEach((text, index) => {
        const cell = parseCell(text);
        if (cell !== undefined) {
          when[keys[index] as string] = cell;
          addRaw(report, kind, `input ${keys[index]} entry`, cell, table.caseType);
        }
      });
      const returns: Record<string, Expr> = {};
      rule.outputs.forEach((text, index) => {
        const expr = parseExpr(text);
        if (expr !== undefined) {
          returns[outputNames[index] as string] = expr;
          addRaw(report, kind, `output ${outputNames[index]}`, expr, table.caseType);
        }
      });
      return {
        ...(rule.description === undefined ? {} : { description: rule.description }),
        ...(Object.keys(when).length > 0 ? { when } : {}),
        ...(Object.keys(returns).length > 0 ? { returns } : {})
      };
    });
  };
  const rowIdentity = (row: Row): string =>
    JSON.stringify(row, (_key, value) => (typeof value === "object" && value !== null && "feel" in value ? { feel: normaliseFeel(value.feel) } : value));
  let rowOrder: Array<Merged<Row>> = [];
  for (const table of tables) {
    rowOrder = mergeSequences(rowOrder, table.caseType, rowsOf(table), rowIdentity);
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
    const typeRef = pick(perType.map(({ caseType, helper }) => ({ caseType, value: helper.variable?.typeRef })));
    const language = pick(perType.map(({ caseType, helper }) => ({ caseType, value: helper.literal?.expressionLanguage })));
    const ttl = pick(perType.map(({ caseType, helper }) => ({ caseType, value: helper.historyTimeToLive })));
    const expression = pick(
      perType.map(({ caseType, helper }) => {
        const expr = parseExpr(helper.literal?.text ?? "");
        addRaw(report, kind, `helper ${name}`, expr, caseType);
        return { caseType, value: JSON.stringify(expr ?? { feel: "" }) };
      })
    );
    const overrides: Record<string, Record<string, unknown>> = {};
    for (const [caseType, value] of Object.entries(expression.overrides)) {
      setOverride(overrides, caseType, "expression", JSON.parse(value ?? '{"feel":""}'));
    }
    for (const [field, picked] of [
      ["typeRef", typeRef],
      ["language", language],
      ["historyTimeToLive", ttl]
    ] as const) {
      for (const [caseType, value] of Object.entries(picked.overrides)) {
        setOverride(overrides, caseType, field, value ?? null);
      }
    }
    return {
      name,
      ...(typeRef.base === undefined ? {} : { typeRef: typeRef.base }),
      ...(language.base === undefined ? {} : { language: language.base }),
      ...(ttl.base === undefined ? {} : { historyTimeToLive: ttl.base }),
      expression: JSON.parse(expression.base ?? '{"feel":""}'),
      ...(sameCaseTypes(present, caseTypes) ? { only: present } : {}),
      ...(Object.keys(overrides).length > 0 ? { overrides } : {})
    } as Helper;
  });

  const edges: Array<{ dep: Dependency; caseTypes: string[] }> = [];
  for (const table of tables) {
    const nameOf = new Map(table.document.decisions.map((d) => [d.id, d.name]));
    for (const decision of table.document.decisions) {
      const from = decision === table.decision ? "table" : decision.name;
      for (const required of decision.requires) {
        const to = nameOf.get(required) ?? required;
        const edge = edges.find((e) => e.dep.decision === from && e.dep.requires === to);
        if (edge) {
          edge.caseTypes.push(table.caseType);
        } else {
          edges.push({ dep: { decision: from, requires: to }, caseTypes: [table.caseType] });
        }
      }
    }
  }
  const dependencies = edges.map(({ dep, caseTypes: present }) => ({ ...dep, ...(sameCaseTypes(present, caseTypes) ? { only: present } : {}) }));

  const name = pick(tables.map((t) => ({ caseType: t.caseType, value: t.decision.name })));
  const hitPolicy = pick(tables.map((t) => ({ caseType: t.caseType, value: t.decision.table?.hitPolicy })));
  const aggregation = pick(tables.map((t) => ({ caseType: t.caseType, value: t.decision.table?.aggregation })));
  const ttl = pick(tables.map((t) => ({ caseType: t.caseType, value: t.decision.historyTimeToLive })));
  const overrides: Record<string, Record<string, string | null>> = {};
  for (const [field, picked] of [
    ["name", name],
    ["hitPolicy", hitPolicy],
    ["aggregation", aggregation],
    ["historyTimeToLive", ttl]
  ] as const) {
    for (const [caseType, value] of Object.entries(picked.overrides)) {
      if (value === undefined && (field === "name" || field === "hitPolicy")) {
        throw new Error(`${kind}: ${field} is absent for ${caseType}`);
      }
      setOverride(overrides, caseType, field, value ?? null);
    }
  }
  if (!HIT_POLICIES.includes(hitPolicy.base as (typeof HIT_POLICIES)[number])) {
    throw new Error(`${kind}: unsupported hit policy ${hitPolicy.base}`);
  }
  void allCaseTypes;
  return {
    name: name.base as string,
    hitPolicy: hitPolicy.base as (typeof HIT_POLICIES)[number],
    ...(aggregation.base && AGGREGATIONS.includes(aggregation.base as (typeof AGGREGATIONS)[number])
      ? { aggregation: aggregation.base as (typeof AGGREGATIONS)[number] }
      : {}),
    ...(ttl.base === undefined ? {} : { historyTimeToLive: ttl.base }),
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    inputs,
    outputs,
    rows,
    ...(helpers.length > 0 ? { helpers } : {}),
    ...(dependencies.length > 0 ? { dependencies } : {})
  } as Decision;
}

/** Builds one spec from every case type's DMNs of a service, and reports what could not be represented structurally. */
export function importDmns(files: DmnFile[], options: ImportOptions = {}): { spec: Spec; report: ImportReport } {
  const report: ImportReport = { files: [], entries: {}, rawFeel: [], unrepresentable: [], presentation: [], notes: [] };
  const byKind = new Map<Kind, Table[]>();
  const slugs = new Set<string>();
  const caseTypeOrder: string[] = [];
  const unrepresentable = new Map<string, { count: number; files: string[] }>();
  const presentation = new Map<string, number>();

  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const match = FILE_PATTERN.exec(file.name);
    if (!match) {
      report.notes.push(`${file.name}: not a wa-task-<kind>-<service>-<caseType>.dmn file, skipped`);
      continue;
    }
    const kind = KIND_OF_FILE[match[1] as string] as Kind;
    const caseType = match[3] as string;
    slugs.add(match[2] as string);
    if (!caseTypeOrder.includes(caseType)) {
      caseTypeOrder.push(caseType);
    }
    const document = parseDmn(file.xml);
    const stem = file.name.replace(/\.dmn$/, "");
    const decision = document.decisions.find((d) => d.id === stem) ?? document.decisions.find((d) => d.table);
    if (!decision?.table) {
      report.notes.push(`${file.name}: no decision table found, skipped`);
      continue;
    }
    const helpers = document.decisions.filter((d) => d !== decision);
    for (const helper of helpers) {
      if (!helper.literal || helper.table) {
        unrepresentable.set(`helper decision ${helper.name} is not a literal expression`, { count: 1, files: [file.name] });
      }
      if (helper.variable && helper.variable.name !== helper.name) {
        unrepresentable.set(`helper ${helper.name} has a variable named ${helper.variable.name}`, { count: 1, files: [file.name] });
      }
    }
    if (document.name !== "DRD") {
      report.notes.push(`${file.name}: definitions name ${document.name} is replaced with DRD`);
    }
    const inspection = inspectDmn(file.xml);
    for (const [construct, count] of inspection.unrepresentable) {
      const entry = unrepresentable.get(construct) ?? { count: 0, files: [] };
      entry.count += count;
      entry.files.push(file.name);
      unrepresentable.set(construct, entry);
    }
    for (const [construct, count] of inspection.presentation) {
      presentation.set(construct, (presentation.get(construct) ?? 0) + count);
    }
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
    report.notes.push(`files name more than one service segment (${[...slugs].join(", ")}); the first is used`);
  }

  const decisions: Spec["decisions"] = {};
  for (const kind of KINDS) {
    const tables = byKind.get(kind);
    if (tables) {
      decisions[kind] = importTables(kind, tables, caseTypeOrder, report);
    }
  }
  report.unrepresentable = [...unrepresentable].map(([construct, v]) => ({ construct, ...v }));
  report.presentation = [...presentation].map(([construct, count]) => ({ construct, count }));
  const slug = [...slugs][0] ?? "service";
  return {
    spec: {
      version: 1,
      service: {
        slug,
        ...(options.jurisdiction ? { jurisdiction: options.jurisdiction } : {}),
        ...(options.serviceCode ? { serviceCode: options.serviceCode } : {}),
        ...(options.displayName ? { displayName: options.displayName } : {})
      },
      caseTypes: caseTypeOrder.map((id) => ({ id })),
      decisions
    },
    report
  };
}

/** Renders the coverage report as Markdown. */
export function renderReport(report: ImportReport): string {
  const lines: string[] = ["# Import coverage", ""];
  lines.push(`${report.files.length} DMN files read.`, "");
  lines.push("## Entries by kind", "", "| Kind | Entries | Structured | Raw FEEL |", "| --- | ---: | ---: | ---: |");
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
  lines.push("", "## Presentation not carried", "");
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
