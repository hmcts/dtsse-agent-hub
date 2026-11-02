/**
 * The process boundary. Exactly one JSON object goes to stdout, because the
 * skill parses it; everything a human reads goes to stderr.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { workspace } from "./paths.ts";

/** Commentary for a human. Never stdout — that channel carries the result. */
export function say(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** A mistake in how the command was called: reported with its usage, exit 2. */
export class UsageError extends Error {}

export function fail(message: string): never {
  throw new UsageError(message);
}

export function requireService(value: string | undefined): string {
  if (!value) {
    fail("--service is required");
  }
  if (!existsSync(join(workspace(), "apps", value))) {
    fail(`no product apps/${value} in this workspace`);
  }
  return value;
}
