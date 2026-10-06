/**
 * A virtual agent's status, as a pure function of what it was, what the person wants, and the latest report: from
 * the pod's boot script (`POST /api/virtual/{id}/status`) or from the orchestrator's observation of the StatefulSet
 * (`POST /api/orchestrator/virtual-agents/{id}/observed`).
 */

export const VIRTUAL_AGENT_STATUSES = [
  "requested",
  "provisioning",
  "awaiting_credentials",
  "awaiting_login",
  "cloning",
  "running",
  "stopping",
  "stopped",
  "failed"
] as const;

export type VirtualAgentStatus = (typeof VIRTUAL_AGENT_STATUSES)[number];

export const VIRTUAL_AGENT_DESIRED = ["running", "stopped", "deleted"] as const;

export type VirtualAgentDesired = (typeof VIRTUAL_AGENT_DESIRED)[number];

/** What the pod's boot script reports as it works through its steps. */
export const POD_PHASES = ["provisioning", "awaiting_credentials", "awaiting_login", "cloning", "running", "failed"] as const;

export type PodPhase = (typeof POD_PHASES)[number];

/**
 * Which pod phases each status accepts, once the agent is meant to be running.
 *
 * Only the current pod holds a valid launch token, so a report is always about the pod the person asked for. A pod
 * that restarts begins again at `provisioning`, and a new pod may report before the orchestrator has observed it, so
 * every status accepts every phase, `stopping` and `stopped` included, except one: `failed` is left only by a pod
 * that starts again from `provisioning`. A pod that carried on after failing, after signing in to Azure as someone
 * else say, cannot report its way back to `running`.
 */
export const POD_TRANSITIONS: Readonly<Record<VirtualAgentStatus, readonly PodPhase[]>> = {
  requested: POD_PHASES,
  provisioning: POD_PHASES,
  awaiting_credentials: POD_PHASES,
  awaiting_login: POD_PHASES,
  cloning: POD_PHASES,
  running: POD_PHASES,
  stopping: POD_PHASES,
  stopped: POD_PHASES,
  failed: ["provisioning", "failed"]
};

export interface Current {
  status: VirtualAgentStatus;
  desired: VirtualAgentDesired;
  /** How many claims in a row the orchestrator could not apply; none when absent. */
  applyFailures?: number;
}

export interface PodReport {
  source: "pod";
  phase: PodPhase;
  detail?: string | null;
}

/** What the orchestrator saw of the StatefulSet after applying the spec. */
export interface Observation {
  source: "orchestrator";
  replicasReady: number;
  /** The pod's `status.phase`, when there is a pod. */
  podPhase?: string | null;
  /** A container's waiting or terminated reason, or a scheduling failure. */
  reason?: string | null;
  /** The PVC has been deleted, or never existed. */
  diskDeleted?: boolean;
}

/**
 * The status to write and the detail beside it, where `detail: undefined` keeps the detail already stored;
 * `remove` for a deleted agent whose StatefulSet and disk are both gone; or why a report does not apply.
 */
export type Outcome = { status: VirtualAgentStatus; detail?: string | null } | { remove: true } | { refused: string };

/** Container and scheduling reasons that mean the pod will not come up by itself. */
export const FAILING_REASONS: ReadonlySet<string> = new Set([
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
  "OOMKilled",
  "FailedScheduling",
  "Unschedulable"
]);

/** Statuses from which a StatefulSet the orchestrator has just applied for `running` is still coming up. */
const NOT_YET_STARTED: readonly VirtualAgentStatus[] = ["requested", "stopping", "stopped"];

export function isPodPhase(value: unknown): value is PodPhase {
  return typeof value === "string" && (POD_PHASES as readonly string[]).includes(value);
}

function fromPod(current: Current, report: PodReport): Outcome {
  if (current.desired !== "running") {
    return { refused: `the agent is meant to be ${current.desired}, so its pod's reports no longer apply` };
  }
  if (!POD_TRANSITIONS[current.status].includes(report.phase)) {
    return { refused: `a ${current.status} agent cannot become ${report.phase}` };
  }
  return { status: report.phase, detail: report.detail ?? null };
}

/**
 * An observation follows a successful apply, so it clears the orchestrator's apply error from the detail, and an
 * agent failed for that error starts again.
 */
function fromOrchestrator(current: Current, observation: Observation): Outcome {
  const applyFailed = (current.applyFailures ?? 0) > 0;
  switch (current.desired) {
    case "running": {
      const reason = observation.reason ?? "";
      if (FAILING_REASONS.has(reason) || observation.podPhase === "Failed") {
        return { status: "failed", detail: `the pod is not starting: ${reason || "its phase is Failed"}` };
      }
      if (NOT_YET_STARTED.includes(current.status) || (applyFailed && current.status === "failed")) {
        return { status: "provisioning", detail: null };
      }
      return applyFailed ? { status: current.status, detail: null } : { status: current.status };
    }
    case "stopped":
      return observation.replicasReady === 0 && !observation.podPhase ? { status: "stopped", detail: null } : { status: "stopping", detail: null };
    case "deleted":
      return observation.replicasReady === 0 && !observation.podPhase && observation.diskDeleted === true
        ? { remove: true }
        : { status: "stopping", detail: null };
  }
}

/**
 * How many claims in a row the orchestrator may fail to apply, about ten minutes at one claim per two-minute claim
 * timeout, before the agent is failed rather than left looking as if it is on its way.
 */
export const APPLY_FAILURES_BEFORE_FAILED = 5;

/** The status and detail once the orchestrator reports that it could not apply the agent's latest generation. */
export function afterApplyError(current: Current, error: string): { status: VirtualAgentStatus; detail: string; applyFailures: number } {
  const applyFailures = (current.applyFailures ?? 0) + 1;
  return {
    status: applyFailures >= APPLY_FAILURES_BEFORE_FAILED ? "failed" : current.status,
    detail: `the orchestrator couldn't apply this agent: ${error}`,
    applyFailures
  };
}

export function nextStatus(current: Current, report: PodReport | Observation): Outcome {
  return report.source === "pod" ? fromPod(current, report) : fromOrchestrator(current, report);
}
