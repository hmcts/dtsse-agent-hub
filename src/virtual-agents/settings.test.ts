import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISK_TTL_DAYS,
  DEFAULT_IDLE_MINUTES,
  diskTtlDays,
  eveningStop,
  idleMinutes,
  orchestratorOids,
  orchestratorRole,
  VirtualAgentConfigurationError,
  virtualAgentsEnabled
} from "./settings.ts";

describe("virtualAgentsEnabled", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["false", false],
    ["TRUE", false],
    ["1", false],
    ["true", true]
  ])("should read VIRTUAL_AGENTS_ENABLED=%s as %s", (value, enabled) => {
    expect(virtualAgentsEnabled({ VIRTUAL_AGENTS_ENABLED: value })).toBe(enabled);
  });
});

describe("idleMinutes and diskTtlDays", () => {
  it("should use the defaults when nothing is set", () => {
    expect(idleMinutes({})).toBe(DEFAULT_IDLE_MINUTES);
    expect(diskTtlDays({ VIRTUAL_AGENT_DISK_TTL_DAYS: " " })).toBe(DEFAULT_DISK_TTL_DAYS);
  });

  it("should read a whole number when one is set", () => {
    expect(idleMinutes({ VIRTUAL_AGENT_IDLE_MINUTES: "45" })).toBe(45);
    expect(diskTtlDays({ VIRTUAL_AGENT_DISK_TTL_DAYS: "7" })).toBe(7);
  });

  it.each(["0", "-5", "1.5", "two"])("should refuse %s when it is not a whole number of at least one", (value) => {
    expect(() => idleMinutes({ VIRTUAL_AGENT_IDLE_MINUTES: value })).toThrow(VirtualAgentConfigurationError);
  });
});

describe("eveningStop", () => {
  it("should default to seven in the evening when nothing is set", () => {
    expect(eveningStop({})).toEqual({ hour: 19, minute: 0 });
  });

  it("should read an HH:MM time when one is set", () => {
    expect(eveningStop({ VIRTUAL_AGENT_EVENING_STOP: "18:30" })).toEqual({ hour: 18, minute: 30 });
  });

  it.each(["7pm", "24:00", "19:60", "9:00"])("should refuse %s when it is not a 24-hour HH:MM", (value) => {
    expect(() => eveningStop({ VIRTUAL_AGENT_EVENING_STOP: value })).toThrow(VirtualAgentConfigurationError);
  });
});

describe("orchestratorOids", () => {
  it("should split, trim and drop blanks when several are set", () => {
    expect(orchestratorOids({ ORCHESTRATOR_OIDS: " a , b,,c " })).toEqual(["a", "b", "c"]);
  });

  it("should be empty when none is set", () => {
    expect(orchestratorOids({})).toEqual([]);
  });
});

describe("orchestratorRole", () => {
  it("should be the trimmed role when one is set", () => {
    expect(orchestratorRole({ ORCHESTRATOR_ROLE: " VirtualAgents.Orchestrate " })).toBe("VirtualAgents.Orchestrate");
  });

  it.each([undefined, "", "  "])("should require no role when it is %j", (value) => {
    expect(orchestratorRole({ ORCHESTRATOR_ROLE: value })).toBeNull();
  });
});
