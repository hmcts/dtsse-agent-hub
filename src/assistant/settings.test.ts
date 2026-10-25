import { describe, expect, it } from "vitest";
import { VIRTUAL_AGENT_STATUSES, type VirtualAgentStatus } from "../virtual-agents/lifecycle.ts";
import { assistantPluginsData } from "./settings.ts";

const ID = "0f8a6a1e-0000-4000-8000-000000000001";
const OFFERED = [
  { name: "pcs", description: "PCS team workflows" },
  { name: "dtsse", description: "" }
];

function assistant(status: VirtualAgentStatus, desired: "running" | "stopped" | "deleted" = "running") {
  return { id: ID, desired, status };
}

describe("assistantPluginsData", () => {
  it("should carry the agent the plugins belong to, what is offered and what is ticked", () => {
    const data = assistantPluginsData(assistant("running"), { available: OFFERED, checked: ["pcs"] });

    expect(data).toEqual({ assistantId: ID, available: OFFERED, checked: ["pcs"], podRunning: true });
  });

  it.each(VIRTUAL_AGENT_STATUSES.filter((status) => status !== "requested"))("should have a pod when the agent is wanted running and %s", (status) => {
    expect(assistantPluginsData(assistant(status), { available: OFFERED, checked: [] }).podRunning).toBe(true);
  });

  it("should have no pod yet when the agent has only just been requested", () => {
    expect(assistantPluginsData(assistant("requested"), { available: OFFERED, checked: [] }).podRunning).toBe(false);
  });

  it.each(["stopped", "deleted"] as const)("should have no pod when the agent is wanted %s", (desired) => {
    expect(assistantPluginsData(assistant("running", desired), { available: OFFERED, checked: [] }).podRunning).toBe(false);
  });

  it("should still have something to show when the hub simply offers no plugins", () => {
    expect(assistantPluginsData(assistant("running"), { available: [], checked: [] })).toEqual({
      assistantId: ID,
      available: [],
      checked: [],
      podRunning: true
    });
  });
});
