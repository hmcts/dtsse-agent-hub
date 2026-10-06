import { describe, expect, it } from "vitest";
import { agentPath } from "./path.ts";

describe("agentPath", () => {
  it("should point at the agent's own page when no virtual agent registered it", () => {
    expect(agentPath({ id: "agent-1", virtualAgentId: null })).toBe("/agents/agent-1");
  });

  it("should point at the virtual agent's page when a virtual agent's session registered it", () => {
    expect(agentPath({ id: "agent-1", virtualAgentId: "va-1" })).toBe("/agents/va-1");
  });
});
