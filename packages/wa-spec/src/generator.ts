import { type DmnDecision, type DmnDocument, type DmnInput, type DmnOutput, type DmnRule, type DmnTable, ncName, uniqueId, writeDmn } from "./dmn-model.ts";
import { renderCell, renderExpr } from "./feel.ts";
import { decisionKeyOf, fileNameOf } from "./file-names.ts";
import { applyLayout, type Layout, layoutKey } from "./layout.ts";
import { type Decision, type Expr, KINDS, type Kind, type Spec } from "./schema.ts";

export interface GeneratedFile {
  fileName: string;
  kind: Kind;
  caseType: string;
  xml: string;
}

/** An override's value when it has one: `null` removes the property, and absence keeps the base. */
const overridden = <T>(override: T | null | undefined, base: T | undefined): T | undefined => (override === undefined ? base : (override ?? undefined));

const applies = (only: string[] | undefined, caseType: string): boolean => only === undefined || only.includes(caseType);

export function decisionKey(spec: Spec, kind: Kind, caseType: string): string {
  return decisionKeyOf(spec.service.slug, kind, caseType);
}

/** The expression language an entry names, or none. */
const languageOf = (entry: unknown): string => (typeof entry === "object" && entry !== null && "language" in entry ? String(entry.language) : "");

/** The columns of a decision table, and the rows that apply, for one case type. `override` changes the hit policy and aggregation. */
function buildTable(
  source: Pick<Decision, "hitPolicy" | "aggregation" | "inputs" | "outputs" | "rows">,
  override: { hitPolicy?: Decision["hitPolicy"]; aggregation?: Decision["aggregation"] | null } | undefined,
  caseType: string
): { table: DmnTable; keys: string[] } {
  const inputs = source.inputs.filter((c) => applies(c.only, caseType));
  const outputs = source.outputs.filter((c) => applies(c.only, caseType));
  const tableInputs: DmnInput[] = inputs.map((column) => {
    const columnOverride = column.overrides?.[caseType];
    const label = overridden(columnOverride?.label, column.label);
    const inputVariable = overridden(columnOverride?.variable, column.variable);
    const typeRef = overridden(columnOverride?.typeRef, column.typeRef);
    const expressionLanguage = overridden(columnOverride?.language, column.language);
    const allowedValues = overridden(columnOverride?.allowedValues, column.allowedValues);
    return {
      ...(label === undefined ? {} : { label }),
      ...(inputVariable === undefined ? {} : { inputVariable }),
      ...(typeRef === undefined ? {} : { typeRef }),
      ...(expressionLanguage === undefined ? {} : { expressionLanguage }),
      ...(allowedValues === undefined ? {} : { allowedValues }),
      expression: renderExpr((columnOverride?.expression === undefined ? column.expression : columnOverride.expression) as Expr | undefined)
    };
  });
  const tableOutputs: DmnOutput[] = outputs.map((column) => {
    const columnOverride = column.overrides?.[caseType];
    const label = overridden(columnOverride?.label, column.label);
    const typeRef = overridden(columnOverride?.typeRef, column.typeRef);
    return { ...(label === undefined ? {} : { label }), name: column.name, ...(typeRef === undefined ? {} : { typeRef }) };
  });
  const rules: DmnRule[] = source.rows
    .filter((row) => applies(row.only, caseType))
    .map((row) => {
      const inputLanguages = inputs.map((column) => languageOf(row.when?.[column.key]));
      const outputLanguages = outputs.map((column) => languageOf(row.returns?.[column.name]));
      return {
        ...(row.description === undefined ? {} : { description: row.description }),
        ...(inputLanguages.some(Boolean) ? { inputLanguages } : {}),
        ...(outputLanguages.some(Boolean) ? { outputLanguages } : {}),
        inputs: inputs.map((column) => renderCell(row.when?.[column.key])),
        outputs: outputs.map((column) => renderExpr(row.returns?.[column.name]))
      };
    });
  const aggregation = overridden(override?.aggregation, source.aggregation);
  return {
    table: {
      hitPolicy: override?.hitPolicy ?? source.hitPolicy,
      ...(aggregation === undefined ? {} : { aggregation }),
      inputs: tableInputs,
      outputs: tableOutputs,
      rules
    },
    keys: inputs.map((c) => c.key)
  };
}

/**
 * The DMN document one kind of decision takes for one case type. `layout` supplies the ids, widths and diagram a spec
 * imported from DMNs came with; whatever it lacks is generated.
 */
export function generateDocument(spec: Spec, kind: Kind, caseType: string, layout?: Layout): DmnDocument | undefined {
  const decision: Decision | undefined = spec.decisions[kind];
  if (!decision || !applies(decision.only, caseType) || !spec.caseTypes.some((c) => c.id === caseType)) {
    return undefined;
  }
  const own = decision.overrides?.[caseType];
  const main = buildTable(decision, own, caseType);

  const fileLayout = layout?.files[layoutKey(kind, caseType)];
  const helpers = (decision.helpers ?? []).filter((h) => applies(h.only, caseType));
  const taken = new Set([decisionKey(spec, kind, caseType), ...helpers.flatMap((h) => fileLayout?.decisions[h.name]?.id ?? [])]);
  const helperIds = new Map(helpers.map((h) => [h.name, fileLayout?.decisions[h.name]?.id ?? uniqueId(ncName(`Decision_${h.name}`), taken)]));
  const helperId = (name: string): string => helperIds.get(name) ?? ncName(`Decision_${name}`);
  const requiresOf = (from: string): string[] =>
    (decision.dependencies ?? []).filter((d) => d.decision === from && applies(d.only, caseType)).map((d) => helperId(d.requires));
  const mainId = decisionKey(spec, kind, caseType);
  const ttl = overridden(own?.historyTimeToLive, decision.historyTimeToLive);
  const mainDecision: DmnDecision = {
    id: mainId,
    name: own?.name ?? decision.name,
    ...(ttl === undefined ? {} : { historyTimeToLive: ttl }),
    requires: requiresOf("table"),
    table: main.table
  };
  const helperDecisions: DmnDecision[] = helpers.map((helper) => {
    const override = helper.overrides?.[caseType];
    const helperTtl = overridden(override?.historyTimeToLive, helper.historyTimeToLive);
    const typeRef = overridden(override?.typeRef, helper.typeRef);
    const language = overridden(override?.language, helper.language);
    const variableName = override?.variable === undefined ? helper.variable : override.variable;
    return {
      id: helperId(helper.name),
      name: helper.name,
      ...(helperTtl === undefined ? {} : { historyTimeToLive: helperTtl }),
      ...(variableName === false ? {} : { variable: { name: variableName ?? helper.name, ...(typeRef === undefined ? {} : { typeRef }) } }),
      requires: requiresOf(helper.name),
      ...(helper.outputs
        ? {
            table: buildTable(
              {
                ...helper,
                hitPolicy: helper.hitPolicy as Decision["hitPolicy"],
                inputs: helper.inputs ?? [],
                outputs: helper.outputs,
                rows: helper.rows ?? []
              },
              override,
              caseType
            ).table
          }
        : {
            literal: {
              text: renderExpr(override?.expression === undefined ? helper.expression : override.expression),
              ...(language === undefined ? {} : { expressionLanguage: language })
            }
          })
    };
  });
  const keys: Record<string, string[]> = { table: main.keys };
  for (const helper of helpers) {
    if (helper.outputs) {
      keys[helper.name] = (helper.inputs ?? []).filter((c) => applies(c.only, caseType)).map((c) => c.key);
    }
  }
  const definitionId = ncName(kind === "task-types" ? `wa-task-types-definition-${caseType}` : `wa-${kind}-definition-${caseType}`);
  const document: DmnDocument = { id: fileLayout?.id ?? definitionId, name: "DRD", decisions: [mainDecision, ...helperDecisions] };
  return applyLayout(document, fileLayout, keys);
}

/** Every DMN the spec describes: each kind it defines, for each case type. */
export function generateAll(spec: Spec, layout?: Layout): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const kind of KINDS) {
    for (const { id: caseType } of spec.caseTypes) {
      const document = generateDocument(spec, kind, caseType, layout);
      if (document) {
        files.push({
          fileName: layout?.files[layoutKey(kind, caseType)]?.fileName ?? fileNameOf(spec.service.slug, kind, caseType),
          kind,
          caseType,
          xml: writeDmn(document)
        });
      }
    }
  }
  return files;
}
