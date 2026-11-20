import type { DmnDocument, DmnOutput, DmnTable } from "../dmn-model.ts";
import { assertFeel, evalExpression, evalTyped, matchesEntry, toPlain, type Variables, withClock } from "./feel-eval.ts";

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
export function evaluateTable(table: DmnTable, givenVariables: Variables, now?: string): OutputRow[] {
  const variables = withClock(givenVariables, now);
  const inputs = table.inputs.map((input, column) => {
    assertFeel(input.expressionLanguage, `input ${column + 1}`);
    const value = input.expression.trim() === "" ? (variables[input.inputVariable ?? ""] ?? null) : evalTyped(input.expression, variables);
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

/**
 * What a required decision table contributes to the decisions that need it, as Camunda's `DefaultDmnDecisionContext` does
 * (`addResultToVariableContext`): nothing when no rule matched; for a single result of a table that is not COLLECT without an
 * aggregation or RULE ORDER, its output columns by name; otherwise each output column as the list of the values of the matching
 * rules that have it (`collectEntries`), a list even when one rule matched, with no padding for a rule that lacks it.
 */
function tableVariables(table: DmnTable, rows: OutputRow[]): Variables {
  if (rows.length === 0) {
    return {};
  }
  const collecting = (table.hitPolicy === "COLLECT" && !table.aggregation) || table.hitPolicy === "RULE ORDER";
  if (rows.length === 1 && !collecting) {
    return { ...rows[0] };
  }
  const names = new Set(rows.flatMap((row) => Object.keys(row)));
  return Object.fromEntries([...names].map((name) => [name, rows.filter((row) => name in row).map((row) => row[name])]));
}

/**
 * Evaluates a decision of the document (with the clock at `now` when given, otherwise the machine's): the decisions it requires first, each exposed to the
 * ones after it, then its own table or literal expression. A literal gives one row holding its value under the decision's variable name.
 */
export function evaluateDecision(document: DmnDocument, decisionId: string, variables: Variables, now?: string): OutputRow[] {
  const byId = new Map(document.decisions.map((d) => [d.id, d]));
  const scope = withClock(variables, now);
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
    if (decision.table) {
      const rows = evaluateTable(decision.table, scope);
      Object.assign(scope, tableVariables(decision.table, rows));
      return rows;
    }
    assertFeel(decision.literal?.expressionLanguage, `decision ${decision.name}`);
    const name = decision.variable?.name ?? decision.name;
    const typed = convertToType(evalTyped(decision.literal?.text ?? "", scope), decision.variable?.typeRef);
    if (decision.variable) {
      scope[name] = typed;
    }
    return [{ [name]: toPlain(typed) }];
  };
  return run(decisionId);
}
