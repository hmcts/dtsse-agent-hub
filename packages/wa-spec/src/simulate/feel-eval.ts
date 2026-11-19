import { evaluate, FeelDate, FeelDateTime, FeelDuration, FeelTime, unaryTest } from "feelin";

export type Variables = Record<string, unknown>;

/** A cell or expression that Camunda would run in an expression language other than FEEL. */
export class UnsupportedLanguageError extends Error {}

const isFeel = (language: string | undefined): boolean => language === undefined || language === "" || language.toLowerCase() === "feel";

export function assertFeel(language: string | undefined, where: string): void {
  if (!isFeel(language)) {
    throw new UnsupportedLanguageError(`${where} uses expression language "${language}"; only FEEL is evaluated`);
  }
}

/** FEEL temporal values as the ISO text a JSON payload would carry; everything else as it is. */
export function toPlain(value: unknown): unknown {
  if (value instanceof FeelTime) {
    return value.iso.replace(/^(\d\d:\d\d):00(?=$|[Z+-])/, "$1");
  }
  if (value instanceof FeelDate || value instanceof FeelDateTime || value instanceof FeelDuration) {
    return (value as { iso?: string }).iso ?? String(value);
  }
  if (Array.isArray(value)) {
    return value.map(toPlain);
  }
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toPlain(entry)]));
  }
  return value;
}

/**
 * Built-ins where feelin differs from Camunda's FEEL for an input ET's tests give. feelin reads a context as a one-item list, so
 * `count` of one is 1; Camunda gives null for anything that is not a list.
 */
const CAMUNDA_BUILTINS: Variables = { count: (list: unknown) => (Array.isArray(list) ? list.length : null) };

/** FEEL that does not parse, with the text that failed. */
export class FeelSyntaxError extends Error {
  constructor(
    readonly expression: string,
    cause: unknown
  ) {
    super(`${cause instanceof Error ? cause.message : String(cause)}: ${expression}`, { cause });
  }
}

function run<T>(text: string, body: () => T): T {
  try {
    return body();
  } catch (error) {
    throw new FeelSyntaxError(text, error);
  }
}

/**
 * Camunda's FEEL accepts a line break inside a string literal, which the grammar feelin uses does not, so a break inside
 * quotes is written as the escape for it.
 */
export function escapeLineBreaksInStrings(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (inString && c === "\\") {
      out += c + text.charAt(++i);
    } else if (c === '"') {
      inString = !inString;
      out += c;
    } else if (inString && (c === "\n" || c === "\r")) {
      out += c === "\n" ? "\\n" : "\\r";
    } else {
      out += c;
    }
  }
  return out;
}

/** Evaluates a FEEL expression; an empty one is null, as Camunda treats an empty entry. */
export function evalExpression(text: string, variables: Variables): unknown {
  if (text.trim() === "") {
    return null;
  }
  return toPlain(run(text, () => evaluate(escapeLineBreaksInStrings(text), { ...CAMUNDA_BUILTINS, ...variables }).value));
}

/** Whether a decision table input entry (a FEEL unary-tests list) accepts the input value; an empty entry or `-` accepts anything. */
export function matchesEntry(text: string, input: unknown, variables: Variables, inputVariable: string | undefined): boolean {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "-") {
    return true;
  }
  const scope: Variables = { ...CAMUNDA_BUILTINS, ...variables, cellInput: input, "?": input };
  if (inputVariable) {
    scope[inputVariable] = input;
  }
  return run(trimmed, () => unaryTest(escapeLineBreaksInStrings(trimmed), scope).value === true);
}
