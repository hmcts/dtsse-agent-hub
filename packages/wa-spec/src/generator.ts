import { type DmnDecision, type DmnDocument, type DmnInput, type DmnOutput, type DmnRule, writeDmn } from "./dmn-model.ts";
import { renderCell, renderExpr } from "./feel.ts";
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

function helperId(name: string): string {
  return `Decision_${name}`;
}

/** The DMN document one kind of decision takes for one case type. */
export function generateDocument(spec: Spec, kind: Kind, caseType: string): DmnDocument | undefined {
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
      expression: renderExpr((override?.expression ?? column.expression) as Expr | undefined)
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

  const helpers = (decision.helpers ?? []).filter((h) => applies(h.only, caseType));
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
    return {
      id: helperId(helper.name),
      name: helper.name,
      ...(helperTtl === undefined ? {} : { historyTimeToLive: helperTtl }),
      variable: { name: helper.name, ...(typeRef === undefined ? {} : { typeRef }) },
      requires: requiresOf(helper.name),
      literal: { text: renderExpr(override?.expression ?? helper.expression), ...(language === undefined ? {} : { expressionLanguage: language }) }
    };
  });
  const definitionId = kind === "task-types" ? `wa-task-types-definition-${caseType}` : `wa-${kind}-definition-${caseType}`;
  return { id: definitionId, name: "DRD", decisions: [main, ...helperDecisions] };
}

/** Every DMN the spec describes: each kind it defines, for each case type. */
export function generateAll(spec: Spec): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const kind of KINDS) {
    for (const { id: caseType } of spec.caseTypes) {
      const document = generateDocument(spec, kind, caseType);
      if (document) {
        files.push({ fileName: `${decisionKey(spec, kind, caseType)}.dmn`, kind, caseType, xml: writeDmn(document) });
      }
    }
  }
  return files;
}
