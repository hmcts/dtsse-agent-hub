import type { CredentialKind } from "../credentials/names.ts";
import type { VirtualAgentStatus } from "../virtual-agents/lifecycle.ts";

/**
 * How far the person's assistant has got, as the getting-ready screen shows it: a bar, a line of plain words, and
 * whether they still have something to connect. Someone with every needed credential stored has onboarded, and is
 * not taken through the connections again; they wait on the warming-up screen whenever they arrive to an assistant
 * that is not running, and are asked only for a sign-in its pod has stopped to ask them for.
 */

export interface Readiness {
  /** 0 to 100. */
  percent: number;
  step: string;
  ready: boolean;
  failed: boolean;
}

const STEPS: Readonly<Record<VirtualAgentStatus, { percent: number; step: string }>> = {
  requested: { percent: 10, step: "Starting your assistant…" },
  provisioning: { percent: 30, step: "Starting your assistant…" },
  awaiting_credentials: { percent: 55, step: "Waiting for you to connect your accounts…" },
  awaiting_login: { percent: 55, step: "Waiting for you to connect your accounts…" },
  cloning: { percent: 80, step: "Preparing your workspace…" },
  running: { percent: 100, step: "Your assistant is ready" },
  stopping: { percent: 5, step: "Starting your assistant again…" },
  stopped: { percent: 5, step: "Starting your assistant again…" },
  failed: { percent: 0, step: "Your assistant could not start" }
};

export function readiness(status: VirtualAgentStatus): Readiness {
  const step = STEPS[status];
  return { ...step, ready: status === "running", failed: status === "failed" };
}

/** Whether the person has stored every credential their assistant needs, which is what onboarding is. */
export function onboarded(needed: readonly CredentialKind[], stored: ReadonlySet<CredentialKind>): boolean {
  return needed.every((kind) => stored.has(kind));
}

/**
 * What the getting-ready screen asks of the person: to connect their accounts, nothing because they have, or
 * nothing because the hub cannot tell.
 *
 * `onboarded` alone cannot say which of the last two it is. It is built from the credentials the hub managed to
 * read, so it is false both for someone who has connected nothing and for someone whose stored sign-ins the hub
 * could not see — and `unavailable` is the only thing that tells the two apart. Reading the second as the first
 * walks a person who has signed in everywhere back through connections they already made, and holds them behind a
 * button they can never satisfy, so it is the mistake worth going out of the way to avoid.
 */
export type ConnectionsAsk = "connect" | "done" | "unknown";

export function connectionsAsk(onboarded: boolean, unavailable: string | null): ConnectionsAsk {
  if (unavailable !== null) {
    return "unknown";
  }
  return onboarded ? "done" : "connect";
}
