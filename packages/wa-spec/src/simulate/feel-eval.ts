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

/** Java's `toString` leaves out zero seconds, but only when there is no fraction of a second after them. */
const withoutZeroSeconds = (text: string): string => text.replace(/^(.*T)?(\d\d:\d\d):00(?=$|[Z+-])/, "$1$2");

/**
 * A date and time as Java's `ZonedDateTime` or `LocalDateTime` writes it, which Camunda hands task management: a zoned one
 * with its UTC offset (`Z` for zero) and a region zone in brackets, whatever time zone the machine is in. `nested` is a value
 * inside a context or list, which Camunda's JSON writes with its seconds and without the region.
 */
function dateTimeText(value: FeelDateTime, nested: boolean): string {
  const text = nested ? (t: string) => t : withoutZeroSeconds;
  if (value.zone === null) {
    return text(value.value.toString());
  }
  const zoned = value.value.toZonedDateTime(value.zone);
  const offset = zoned.offset === "+00:00" ? "Z" : zoned.offset;
  const region = nested || /^[+-]\d\d:\d\d$|^Z$/.test(value.zone) ? "" : `[${value.zone}]`;
  return `${text(zoned.toPlainDateTime().toString())}${offset}${region}`;
}

/** FEEL temporal values as the text Camunda gives for them; everything else as it is. */
export function toPlain(value: unknown, nested = false): unknown {
  if (value instanceof FeelTime) {
    return nested ? value.iso : withoutZeroSeconds(value.iso);
  }
  if (value instanceof FeelDateTime) {
    return dateTimeText(value, nested);
  }
  if (value instanceof FeelDate || value instanceof FeelDuration) {
    return (value as { iso?: string }).iso ?? String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => toPlain(item, true));
  }
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toPlain(entry, true)]));
  }
  return value;
}

/**
 * Built-ins where feelin differs from Camunda's FEEL for inputs the services' tests give. feelin reads a context as a one-item
 * list, so `count` of one is 1; Camunda gives null for anything that is not a list. feelin's `contains` is for strings only;
 * Camunda's also finds an item in a list, which sscs uses on the case roles.
 */
const CAMUNDA_BUILTINS: Variables = {
  count: (list: unknown) => (Array.isArray(list) ? list.length : null),
  contains: (source: unknown, match: unknown) => {
    if (Array.isArray(source)) {
      return source.includes(match);
    }
    return typeof source === "string" && typeof match === "string" ? source.includes(match) : null;
  }
};

/**
 * The variables with `now()` and `today()` fixed at an instant, an ISO date and time with an offset. The DMNs read the clock, so
 * a run that must be repeatable gives one rather than relying on the machine's.
 */
export function withClock(variables: Variables, now: string | undefined): Variables {
  if (now === undefined) {
    return variables;
  }
  const at = evaluate("date and time(s)", { s: now }).value;
  const day = evaluate("date(s)", { s: now.slice(0, 10) }).value;
  return { ...variables, now: () => at, today: () => day };
}

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
