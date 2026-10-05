/**
 * The orchestrator's one logger: a JSON object per line on stdout. Messages and field values include text from the
 * hub, the API server and the environment, so every string has its line breaks removed before it is encoded, and no
 * line can be forged by what it quotes.
 */

export type Level = "info" | "warn" | "error";
export type Log = (level: Level, message: string, fields?: Record<string, unknown>) => void;

const LINE_BREAKS = /[\r\n\u2028\u2029]/g;

export function oneLine(text: string): string {
  return text.replace(LINE_BREAKS, " ");
}

function clean(value: unknown): unknown {
  if (typeof value === "string") {
    return oneLine(value);
  }
  if (Array.isArray(value)) {
    return value.map(clean);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [oneLine(key), clean(entry)]));
  }
  return value;
}

export function describeError(error: unknown): string {
  return oneLine(error instanceof Error ? error.message : String(error));
}

export function createLogger(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`), clock: () => Date = () => new Date()): Log {
  return (level, message, fields = {}) => {
    const entry = { ...(clean(fields) as Record<string, unknown>), time: clock().toISOString(), level, message: oneLine(message) };
    write(JSON.stringify(entry));
  };
}
