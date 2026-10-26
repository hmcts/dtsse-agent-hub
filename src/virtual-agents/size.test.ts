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
  it("should give each size its CPU and memory, small keeping the limits pods had before sizes", () => {
    expect(SIZE_RESOURCES).toEqual({
      small: { requests: { cpu: "1", memory: "4Gi" }, limits: { cpu: "4", memory: "8Gi" } },
      medium: { requests: { cpu: "2", memory: "8Gi" }, limits: { cpu: "4", memory: "16Gi" } },
      large: { requests: { cpu: "4", memory: "16Gi" }, limits: { cpu: "8", memory: "32Gi" } }
    });
  });
});

describe("sizeLabel", () => {
  it("should describe a size by its CPU and memory range", () => {
    expect(sizeLabel("medium")).toBe("Medium: 2–4 CPUs, 8Gi–16Gi memory");
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
