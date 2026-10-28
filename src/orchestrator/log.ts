/**
 * The orchestrator's one logger: a JSON object per line on stdout. Messages and field values include text from the
 * hub, the API server and the environment, so every string has its line breaks removed before it is encoded, and no
 * line can be forged by what it quotes — nor carry a secret it quotes, which is `redacting`.
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

export const REDACTED = "[redacted]";

/**
 * `text` with every one of `secrets` replaced wherever it appears.
 *
 * By value rather than by shape, because the one secret the orchestrator holds — the gateway's APIM subscription key
 * — is opaque and has no prefix to match on, the way a launch token has `ahv_`. An empty string is skipped: it
 * matches between every character and would redact the whole line.
 */
export function withoutSecrets(text: string, secrets: readonly string[]): string {
  let left = text;
  for (const secret of secrets) {
    if (secret !== "") {
      left = left.replaceAll(secret, REDACTED);
    }
  }
  return left;
}

/**
 * `log` with every secret taken out of each line it writes, however deep in the fields it is quoted.
 *
 * Wrapped here rather than inside each call, because what puts a secret in a log line is not the orchestrator
 * quoting it on purpose: the API server's refusal of an apply quotes the spec it was given, and a `gateway` pod's
 * spec carries the key as a plain value. One service's key, so one leak is every `gateway` pod.
 */
export function redacting(log: Log, secrets: readonly string[]): Log {
  if (secrets.every((secret) => secret === "")) {
    return log;
  }
  const hide = (value: unknown): unknown => {
    if (typeof value === "string") {
      return withoutSecrets(value, secrets);
    }
    if (Array.isArray(value)) {
      return value.map(hide);
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [withoutSecrets(key, secrets), hide(entry)]));
    }
    return value;
  };
  return (level, message, fields = {}) => log(level, withoutSecrets(message, secrets), hide(fields) as Record<string, unknown>);
}
