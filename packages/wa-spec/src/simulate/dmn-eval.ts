import type { DmnDecision, DmnDocument, DmnOutput, DmnTable } from "../dmn-model.ts";
import { assertFeel, evalExpression, matchesEntry, type Variables } from "./feel-eval.ts";

export type OutputRow = Record<string, unknown>;

export class DmnEvaluationError extends Error {}

/** Camunda's conversion of an input or output to its column's `typeRef`; types it has no conversion for pass through. */
function convertToType(value: unknown, typeRef: string | undefined): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  switch (typeRef) {
    case "string":
      return typeof value === "object" ? value : String(value);
    case "integer":
    case "long":
      return typeof value === "number" ? Math.trunc(value) : Number.parseInt(String(value), 10);
    case "double":
      return typeof value === "number" ? value : Number.parseFloat(String(value));
    case "boolean":
      return typeof value === "boolean" ? value : String(value) === "true";
    default:
      return value;
  }
}

function evaluateRule(table: DmnTable, ruleIndex: number, inputs: unknown[], variables: Variables): OutputRow | undefined {
  const rule = table.rules[ruleIndex];
  if (!rule) {
    return undefined;
  }
  for (const [column, input] of table.inputs.entries()) {
    assertFeel(rule.inputLanguages?.[column], `rule ${ruleIndex + 1} input ${column + 1}`);
    if (!matchesEntry(rule.inputs[column] ?? "", inputs[column], variables, input.inputVariable)) {
      return undefined;
    }
  }
  const row: OutputRow = {};
  for (const [column, output] of table.outputs.entries()) {
    const text = rule.outputs[column] ?? "";
    if (text.trim() !== "") {
      assertFeel(rule.outputLanguages?.[column], `rule ${ruleIndex + 1} output ${output.name}`);
      row[output.name] = convertToType(evalExpression(text, variables), output.typeRef);
    }
  }
  return row;
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function aggregate(rows: OutputRow[], output: DmnOutput | undefined, aggregation: string): OutputRow[] {
  const name = output?.name ?? "";
  const values = rows.map((row) => row[name]).filter((value) => value !== null && value !== undefined);
  const numbers = values.map(Number);
  switch (aggregation) {
    case "COUNT":
      return [{ [name]: new Set(values.map((v) => JSON.stringify(v))).size }];
    case "SUM":
      return [{ [name]: numbers.reduce((sum, n) => sum + n, 0) }];
    case "MIN":
      return numbers.length > 0 ? [{ [name]: Math.min(...numbers) }] : [];
    default:
      return numbers.length > 0 ? [{ [name]: Math.max(...numbers) }] : [];
  }
}

/** Applies a decision table the way Camunda 7 does: input expressions once, rules in order, then the hit policy. */
export function evaluateTable(table: DmnTable, variables: Variables): OutputRow[] {
  const inputs = table.inputs.map((input, column) => {
    assertFeel(input.expressionLanguage, `input ${column + 1}`);
    const value = input.expression.trim() === "" ? (variables[input.inputVariable ?? ""] ?? null) : evalExpression(input.expression, variables);
    return convertToType(value, input.typeRef);
  });
  const matched = table.rules.flatMap((_, index) => {
    const row = evaluateRule(table, index, inputs, variables);
    return row === undefined ? [] : [row];
  });
  switch (table.hitPolicy) {
    case "UNIQUE":
      if (matched.length > 1) {
        throw new DmnEvaluationError(`UNIQUE hit policy: ${matched.length} rules matched`);
      }
      return matched;
    case "FIRST":
      return matched.slice(0, 1);
    case "ANY":
      if (matched.some((row) => !sameValue(row, matched[0]))) {
        throw new DmnEvaluationError("ANY hit policy: the matching rules give different outputs");
      }
      return matched.slice(0, 1);
    case "COLLECT":
      return table.aggregation ? aggregate(matched, table.outputs[0], table.aggregation) : matched;
    case "RULE ORDER":
      return matched;
    default:
      throw new DmnEvaluationError(`Hit policy ${table.hitPolicy} is not supported`);
  }
}

/** What a required decision contributes to the variables of the decisions that need it. */
function resultValue(decision: DmnDecision, rows: OutputRow[]): unknown {
  const table = decision.table;
  if (!table) {
    return rows[0];
  }
  const single = table.outputs.length === 1 ? table.outputs[0]?.name : undefined;
  const collects = table.hitPolicy === "COLLECT" || table.hitPolicy === "RULE ORDER";
  if (collects && !table.aggregation) {
    return single === undefined ? rows : rows.map((row) => row[single]);
  }
  const first = rows[0];
  return single === undefined || first === undefined ? first : first[single];
}

/**
 * Evaluates a decision of the document: the decisions it requires first, each exposed under its variable name, then its own
 * table or literal expression. A literal gives one row holding its value under the decision's variable name.
 */
export function evaluateDecision(document: DmnDocument, decisionId: string, variables: Variables): OutputRow[] {
  const byId = new Map(document.decisions.map((d) => [d.id, d]));
  const scope: Variables = { ...variables };
  const done = new Set<string>();
  const run = (id: string): OutputRow[] => {
    const decision = byId.get(id);
    if (!decision) {
      throw new DmnEvaluationError(`Decision ${id} is not in the document`);
    }
    for (const required of decision.requires) {
      if (!done.has(required)) {
        run(required);
      }
    }
    done.add(id);
    let rows: OutputRow[];
    if (decision.table) {
      rows = evaluateTable(decision.table, scope);
    } else {
      assertFeel(decision.literal?.expressionLanguage, `decision ${decision.name}`);
      rows = [{ [decision.variable?.name ?? decision.name]: convertToType(evalExpression(decision.literal?.text ?? "", scope), decision.variable?.typeRef) }];
    }
    if (decision.variable) {
      scope[decision.variable.name] = decision.literal ? rows[0]?.[decision.variable.name] : resultValue(decision, rows);
    }
    return rows;
  };
  return run(decisionId);
}
