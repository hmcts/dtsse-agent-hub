import { describe, expect, it } from "vitest";
import { byCodePoint } from "../topics/slug.ts";
import {
  APPLY_FAILURES_BEFORE_FAILED,
  afterApplyError,
  type Current,
  isPodPhase,
  nextStatus,
  type Observation,
  POD_PHASES,
  POD_TRANSITIONS,
  VIRTUAL_AGENT_DESIRED,
  VIRTUAL_AGENT_STATUSES
} from "./lifecycle.ts";

function observed(overrides: Partial<Observation> = {}): Observation {
  return { source: "orchestrator", replicasReady: 0, ...overrides };
}

describe("POD_TRANSITIONS", () => {
  it("should name every status exactly once when it is read as a table", () => {
    expect(Object.keys(POD_TRANSITIONS).sort(byCodePoint)).toEqual([...VIRTUAL_AGENT_STATUSES].sort(byCodePoint));
  });
});

describe("nextStatus from the pod", () => {
  const cases = VIRTUAL_AGENT_STATUSES.flatMap((status) => POD_PHASES.map((phase) => [status, phase] as const));

  it.each(cases)("should take a %s agent meant to be running to %s only when the table allows it", (status, phase) => {
    const outcome = nextStatus({ status, desired: "running" }, { source: "pod", phase, detail: "cloning hmcts/pcs-api" });

    if (status !== "failed" || phase === "provisioning" || phase === "failed") {
      expect(outcome).toEqual({ status: phase, detail: "cloning hmcts/pcs-api" });
    } else {
      expect(outcome).toEqual({ refused: `a failed agent cannot become ${phase}` });
    }
  });

  it.each(
    VIRTUAL_AGENT_STATUSES.flatMap((status) => (["stopped", "deleted"] as const).map((desired) => [status, desired] as const))
  )("should refuse any report from the pod of a %s agent when it is meant to be %s", (status, desired) => {
    expect(nextStatus({ status, desired }, { source: "pod", phase: "running" })).toEqual({
      refused: `the agent is meant to be ${desired}, so its pod's reports no longer apply`
    });
  });

  it("should clear the detail when the pod sends none", () => {
    expect(nextStatus({ status: "cloning", desired: "running" }, { source: "pod", phase: "running" })).toEqual({ status: "running", detail: null });
  });
});

describe("nextStatus from the orchestrator", () => {
  describe.each(VIRTUAL_AGENT_STATUSES)("for a %s agent", (status) => {
    const running: Current = { status, desired: "running" };

    it("should mark it starting when it is meant to be running and had not started, and leave it otherwise", () => {
      const outcome = nextStatus(running, observed({ replicasReady: 1, podPhase: "Running" }));

      expect(outcome).toEqual(["requested", "stopping", "stopped"].includes(status) ? { status: "provisioning", detail: null } : { status });
    });

    it.each([
      "CrashLoopBackOff",
      "ImagePullBackOff",
      "ErrImagePull",
      "InvalidImageName",
      "CreateContainerConfigError",
      "CreateContainerError",
      "OOMKilled",
      "FailedScheduling",
      "Unschedulable"
    ])("should fail it when it is meant to be running and its pod is stuck on %s", (reason) => {
      expect(nextStatus(running, observed({ reason, podPhase: "Pending" }))).toEqual({ status: "failed", detail: `the pod is not starting: ${reason}` });
    });

    it("should fail it when it is meant to be running and its pod's phase is Failed", () => {
      expect(nextStatus(running, observed({ podPhase: "Failed" }))).toEqual({ status: "failed", detail: "the pod is not starting: its phase is Failed" });
    });

    it("should not fail it when the reason is one a pod recovers from by itself", () => {
      expect(nextStatus(running, observed({ reason: "ContainerCreating", podPhase: "Pending" }))).toEqual(
        nextStatus(running, observed({ podPhase: "Pending" }))
      );
    });

    it("should mark it stopped when it is meant to be stopped and no pod is left", () => {
      expect(nextStatus({ status, desired: "stopped" }, observed())).toEqual({ status: "stopped", detail: null });
    });

    it.each([
      ["a ready replica", observed({ replicasReady: 1, podPhase: "Running" })],
      ["a terminating pod", observed({ podPhase: "Running" })]
    ])("should mark it stopping when it is meant to be stopped and there is still %s", (_label, observation) => {
      expect(nextStatus({ status, desired: "stopped" }, observation)).toEqual({ status: "stopping", detail: null });
    });

    it("should remove it when it is meant to be deleted and its pod and disk are both gone", () => {
      expect(nextStatus({ status, desired: "deleted" }, observed({ diskDeleted: true }))).toEqual({ remove: true });
    });

    it.each([
      ["its disk remains", observed({ diskDeleted: false })],
      ["its pod remains", observed({ podPhase: "Running", diskDeleted: true })],
      ["a replica is still ready", observed({ replicasReady: 1, diskDeleted: true })]
    ])("should mark it stopping when it is meant to be deleted and %s", (_label, observation) => {
      expect(nextStatus({ status, desired: "deleted" }, observation)).toEqual({ status: "stopping", detail: null });
    });
  });
});

describe("isPodPhase", () => {
  it.each(POD_PHASES)("should accept %s when it is a phase the pod reports", (phase) => {
    expect(isPodPhase(phase)).toBe(true);
  });

  it.each(["stopped", "stopping", "requested", "", 1, null])("should refuse %s when it is not one", (value) => {
    expect(isPodPhase(value)).toBe(false);
  });
});

describe("VIRTUAL_AGENT_DESIRED", () => {
  it("should be the three things a person can ask for when it is listed", () => {
    expect(VIRTUAL_AGENT_DESIRED).toEqual(["running", "stopped", "deleted"]);
  });
});

describe("nextStatus from the orchestrator after apply errors", () => {
  it("should start an agent again when it was failed by apply errors and an apply has now worked", () => {
    expect(nextStatus({ status: "failed", desired: "running", applyFailures: 5 }, observed({ podPhase: "Pending" }))).toEqual({
      status: "provisioning",
      detail: null
    });
  });

  it("should leave a pod's own failure as it is when there were no apply errors", () => {
    expect(nextStatus({ status: "failed", desired: "running", applyFailures: 0 }, observed({ podPhase: "Pending" }))).toEqual({ status: "failed" });
  });

  it("should clear the apply error from a running agent's detail when an apply has now worked", () => {
    expect(nextStatus({ status: "running", desired: "running", applyFailures: 2 }, observed({ replicasReady: 1, podPhase: "Running" }))).toEqual({
      status: "running",
      detail: null
    });
  });
});

describe("afterApplyError", () => {
  it("should keep the status and say what the orchestrator could not do when the errors are fewer than the limit", () => {
    expect(afterApplyError({ status: "stopping", desired: "stopped" }, "GET services/va-1: 403 forbidden")).toEqual({
      status: "stopping",
      detail: "the orchestrator couldn't apply this agent: GET services/va-1: 403 forbidden",
      applyFailures: 1
    });
  });

  it("should fail the agent when the errors reach the limit", () => {
    const current: Current = { status: "requested", desired: "running", applyFailures: APPLY_FAILURES_BEFORE_FAILED - 1 };

    expect(afterApplyError(current, "boom")).toMatchObject({ status: "failed", applyFailures: APPLY_FAILURES_BEFORE_FAILED });
  });
});
