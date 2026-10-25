import type { CredentialKind } from "../credentials/names.ts";
import type { VirtualAgentStatus } from "../virtual-agents/lifecycle.ts";

/**
 * How far the person's assistant has got, as the getting-ready screen shows it: a bar, a line of plain words, and
 * whether they still have something to connect. Someone with every needed credential stored has onboarded, and is
 * never asked to connect anything again; they wait on the warming-up screen instead whenever they arrive to an
 * assistant that is not running.
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
