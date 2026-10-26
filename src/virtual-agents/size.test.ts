import { describe, expect, it } from "vitest";
import { checkSize, isVirtualAgentSize, SIZE_RESOURCES, sizeChangeRefusal, sizeChangeRollsPod, sizeLabel, VIRTUAL_AGENT_SIZES } from "./size.ts";

describe("checkSize", () => {
  it.each([undefined, null, "", "  "])("should give the default size when the form sends %j", (raw) => {
    expect(checkSize(raw)).toEqual({ ok: true, size: "small" });
  });

  it.each(VIRTUAL_AGENT_SIZES)("should accept %s in any case", (size) => {
    expect(checkSize(` ${size.toUpperCase()} `)).toEqual({ ok: true, size });
  });

  it.each(["huge", 3, {}])("should refuse %j when it is not a size", (raw) => {
    expect(checkSize(raw)).toEqual({ ok: false, error: "a size is one of small, medium, large" });
  });
});

describe("isVirtualAgentSize", () => {
  it("should know only the three sizes", () => {
    expect(VIRTUAL_AGENT_SIZES.every(isVirtualAgentSize)).toBe(true);
    expect(isVirtualAgentSize("xl")).toBe(false);
    expect(isVirtualAgentSize(undefined)).toBe(false);
  });
});

describe("SIZE_RESOURCES", () => {
  // The figures, not a read-back of the constant: these are what a pod is reserved on the cluster, and a CPU quota
  // left on any of them would throttle a session's bursts for a latency cost nothing here is protected from.
  it("should request CPU and memory and limit memory alone, with no CPU quota on any size, when read", () => {
    expect(SIZE_RESOURCES).toEqual({
      small: { requests: { cpu: "1", memory: "4Gi" }, limits: { memory: "8Gi" } },
      medium: { requests: { cpu: "2", memory: "8Gi" }, limits: { memory: "16Gi" } },
      large: { requests: { cpu: "4", memory: "16Gi" }, limits: { memory: "32Gi" } }
    });
  });
});

describe("sizeLabel", () => {
  // CPU reads as a floor because there is no quota above it; memory as a range because the kernel enforces the top.
  it.each([
    ["small", "Small: from 1 CPU, 4Gi–8Gi memory"],
    ["medium", "Medium: from 2 CPUs, 8Gi–16Gi memory"],
    ["large", "Large: from 4 CPUs, 16Gi–32Gi memory"]
  ] as const)("should describe %s by the CPU it guarantees and its memory range", (size, label) => {
    expect(sizeLabel(size)).toBe(label);
  });
});

describe("sizeChangeRefusal", () => {
  it.each([
    ["requested", "running"],
    ["stopped", "stopped"],
    ["stopped", "running"]
  ] as const)("should allow a change when the agent is %s and meant to be %s", (status, desired) => {
    expect(sizeChangeRefusal({ status, desired })).toBeUndefined();
  });

  // A running pod is replaced by the change, as a change of plugins replaces it, and what makes that honest is the UI
  // saying so. Refusing here would put the setting out of reach of the Assistant, whose pod starts whenever its owner
  // opens it.
  it.each(["provisioning", "awaiting_login", "running", "stopping", "failed"] as const)("should allow a change while the agent is %s", (status) => {
    expect(sizeChangeRefusal({ status, desired: "running" })).toBeUndefined();
  });

  it("should refuse a change when the agent is being deleted", () => {
    expect(sizeChangeRefusal({ status: "stopped", desired: "deleted" })).toBe("that virtual agent is being deleted");
  });
});

describe("sizeChangeRollsPod", () => {
  it.each(["provisioning", "awaiting_login", "running", "stopping", "failed"] as const)("should replace the pod when the agent is %s", (status) => {
    expect(sizeChangeRollsPod({ status, desired: "running" })).toBe(true);
  });

  it("should replace no pod before the orchestrator has made one", () => {
    expect(sizeChangeRollsPod({ status: "requested", desired: "running" })).toBe(false);
  });

  it.each(["stopped", "deleted"] as const)("should replace no pod when the agent is meant to be %s", (desired) => {
    expect(sizeChangeRollsPod({ status: "stopped", desired })).toBe(false);
  });
});
