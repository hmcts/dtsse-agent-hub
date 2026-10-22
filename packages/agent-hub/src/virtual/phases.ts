// The lifecycle a virtual agent's pod reports to the hub, and the pieces every other module in this folder
// needs: where the pod keeps its sync markers, how it talks to its entrypoint's log, and the one outcome the
// entrypoint must not retry.
import fs from "node:fs";
import path from "node:path";
import type { VirtualPhase } from "../api.ts";
import { hubHome } from "../session.ts";

export const PHASES = ["provisioning", "awaiting_credentials", "awaiting_login", "cloning", "running", "failed"] as const satisfies readonly VirtualPhase[];

export const EXIT_FATAL = 3;
export const EXIT_NO_CREDENTIAL = 4;

/** An outcome the pod must not retry: the hub has failed the agent. */
export class FatalError extends Error {}

// `Array.prototype.includes` does not narrow, so a phase read off argv reaches `Api.virtualStatus` only
// through a type predicate.
export function isVirtualPhase(value: unknown): value is VirtualPhase {
  return typeof value === "string" && (PHASES as readonly string[]).includes(value);
}

/** Everything this client tells the pod's operator goes to stderr: stdout carries credential values. */
export function say(message: string): void {
  process.stderr.write(`virtual-agent: ${message}\n`);
}

/** Where the pod records what it has already stored on the hub, so a restart does not re-upload it. */
export function virtualStateDir(): string {
  const dir = path.join(hubHome(), "virtual");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
