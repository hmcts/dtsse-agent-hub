/**
 * The process boundary. Exactly one JSON object goes to stdout, because the skill parses it; everything a human reads
 * goes to stderr.
 */

/** Commentary for a human. Never stdout — that channel carries the result. */
export function say(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** A mistake in how the command was called: reported with its usage, exit 2. */
export class UsageError extends Error {}

export function fail(message: string): never {
  throw new UsageError(message);
}
