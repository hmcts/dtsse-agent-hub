import { type DmnDecision, type DmnDocument, type DmnInput, type DmnOutput, type DmnRule, ncName, uniqueId, writeDmn } from "./dmn-model.ts";
import { renderCell, renderExpr } from "./feel.ts";
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

const KIND_SLUG: Record<Kind, string> = {
  initiation: "initiation",
  configuration: "configuration",
  permissions: "permissions",
  completion: "completion",
  cancellation: "cancellation",
  "task-types": "types"
};

export function decisionKey(spec: Spec, kind: Kind, caseType: string): string {
  return `wa-task-${KIND_SLUG[kind]}-${spec.service.slug}-${caseType}`;
}

/**
 * The DMN document one kind of decision takes for one case type. `layout` supplies the ids, widths and diagram a spec
 * imported from DMNs came with; whatever it lacks is generated.
 */
export function generateDocument(spec: Spec, kind: Kind, caseType: string, layout?: Layout): DmnDocument | undefined {
  const decision: Decision | undefined = spec.decisions[kind];
  if (!decision || !spec.caseTypes.some((c) => c.id === caseType)) {
    return undefined;
  }
  const own = decision.overrides?.[caseType];
  const inputs = decision.inputs.filter((c) => applies(c.only, caseType));
  const outputs = decision.outputs.filter((c) => applies(c.only, caseType));

  const tableInputs: DmnInput[] = inputs.map((column) => {
    const override = column.overrides?.[caseType];
    const label = overridden(override?.label, column.label);
    const inputVariable = overridden(override?.variable, column.variable);
    const typeRef = overridden(override?.typeRef, column.typeRef);
    const expressionLanguage = overridden(override?.language, column.language);
    return {
      ...(label === undefined ? {} : { label }),
      ...(inputVariable === undefined ? {} : { inputVariable }),
      ...(typeRef === undefined ? {} : { typeRef }),
      ...(expressionLanguage === undefined ? {} : { expressionLanguage }),
      expression: renderExpr((override?.expression === undefined ? column.expression : override.expression) as Expr | undefined)
    };
  });
  const tableOutputs: DmnOutput[] = outputs.map((column) => {
    const override = column.overrides?.[caseType];
    const label = overridden(override?.label, column.label);
    const typeRef = overridden(override?.typeRef, column.typeRef);
    return { ...(label === undefined ? {} : { label }), name: column.name, ...(typeRef === undefined ? {} : { typeRef }) };
  });
  const rules: DmnRule[] = decision.rows
    .filter((row) => applies(row.only, caseType))
    .map((row) => ({
      ...(row.description === undefined ? {} : { description: row.description }),
      inputs: inputs.map((column) => renderCell(row.when?.[column.key])),
      outputs: outputs.map((column) => renderExpr(row.returns?.[column.name]))
    }));

  const fileLayout = layout?.files[layoutKey(kind, caseType)];
  const helpers = (decision.helpers ?? []).filter((h) => applies(h.only, caseType));
  const taken = new Set([decisionKey(spec, kind, caseType), ...helpers.flatMap((h) => fileLayout?.decisions[h.name]?.id ?? [])]);
  const helperIds = new Map(helpers.map((h) => [h.name, fileLayout?.decisions[h.name]?.id ?? uniqueId(ncName(`Decision_${h.name}`), taken)]));
  const helperId = (name: string): string => helperIds.get(name) ?? ncName(`Decision_${name}`);
  const requiresOf = (from: string): string[] =>
    (decision.dependencies ?? []).filter((d) => d.decision === from && applies(d.only, caseType)).map((d) => helperId(d.requires));
  const mainId = decisionKey(spec, kind, caseType);
  const hitPolicy = own?.hitPolicy ?? decision.hitPolicy;
  const aggregation = overridden(own?.aggregation, decision.aggregation);
  const ttl = overridden(own?.historyTimeToLive, decision.historyTimeToLive);
  const main: DmnDecision = {
    id: mainId,
    name: own?.name ?? decision.name,
    ...(ttl === undefined ? {} : { historyTimeToLive: ttl }),
    requires: requiresOf("table"),
    table: { hitPolicy, ...(aggregation === undefined ? {} : { aggregation }), inputs: tableInputs, outputs: tableOutputs, rules }
  };
  const helperDecisions: DmnDecision[] = helpers.map((helper) => {
    const override = helper.overrides?.[caseType];
    const helperTtl = overridden(override?.historyTimeToLive, helper.historyTimeToLive);
    const typeRef = overridden(override?.typeRef, helper.typeRef);
    const language = overridden(override?.language, helper.language);
    const hasVariable = (override?.variable ?? helper.variable) !== false;
    return {
      id: helperId(helper.name),
      name: helper.name,
      ...(helperTtl === undefined ? {} : { historyTimeToLive: helperTtl }),
      ...(hasVariable ? { variable: { name: helper.name, ...(typeRef === undefined ? {} : { typeRef }) } } : {}),
      requires: requiresOf(helper.name),
      literal: {
        text: renderExpr(override?.expression === undefined ? helper.expression : override.expression),
        ...(language === undefined ? {} : { expressionLanguage: language })
      }
    };
  });
  const definitionId = ncName(kind === "task-types" ? `wa-task-types-definition-${caseType}` : `wa-${kind}-definition-${caseType}`);
  const document: DmnDocument = { id: fileLayout?.id ?? definitionId, name: "DRD", decisions: [main, ...helperDecisions] };
  return applyLayout(
    document,
    fileLayout,
    inputs.map((column) => column.key)
  );
}

/** Every DMN the spec describes: each kind it defines, for each case type. */
export function generateAll(spec: Spec, layout?: Layout): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const kind of KINDS) {
    for (const { id: caseType } of spec.caseTypes) {
      const document = generateDocument(spec, kind, caseType, layout);
      if (document) {
        files.push({ fileName: `${decisionKey(spec, kind, caseType)}.dmn`, kind, caseType, xml: writeDmn(document) });
      }
    }
  }
  return files;
}
