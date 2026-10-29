import { describe, expect, it } from "vitest";
import {
  awaitingOwnerMinutes,
  DEFAULT_AWAITING_OWNER_MINUTES,
  DEFAULT_DISK_TTL_DAYS,
  DEFAULT_IDLE_MINUTES,
  DEFAULT_ORCHESTRATOR_LEASE_SECONDS,
  diskTtlDays,
  eveningStop,
  gatewaySettings,
  idleMinutes,
  orchestratorLeaseSeconds,
  orchestratorOids,
  orchestratorRole,
  publicDomain,
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

describe("awaitingOwnerMinutes", () => {
  it("should default to half an hour, well inside the idle period, when nothing is set", () => {
    expect(awaitingOwnerMinutes({})).toBe(DEFAULT_AWAITING_OWNER_MINUTES);
    expect(DEFAULT_AWAITING_OWNER_MINUTES).toBe(30);
    expect(DEFAULT_AWAITING_OWNER_MINUTES).toBeLessThan(DEFAULT_IDLE_MINUTES);
  });

  it("should read a whole number when one is set", () => {
    expect(awaitingOwnerMinutes({ VIRTUAL_AGENT_AWAITING_OWNER_MINUTES: "10" })).toBe(10);
  });

  it.each(["0", "-5", "1.5", "two"])("should refuse %s when it is not a whole number of at least one", (value) => {
    expect(() => awaitingOwnerMinutes({ VIRTUAL_AGENT_AWAITING_OWNER_MINUTES: value })).toThrow(VirtualAgentConfigurationError);
  });
});

describe("orchestratorLeaseSeconds", () => {
  it("should default to two minutes when nothing is set", () => {
    expect(orchestratorLeaseSeconds({})).toBe(DEFAULT_ORCHESTRATOR_LEASE_SECONDS);
    expect(DEFAULT_ORCHESTRATOR_LEASE_SECONDS).toBe(120);
  });

  it("should read a whole number of seconds when one is set", () => {
    expect(orchestratorLeaseSeconds({ ORCHESTRATOR_LEASE_SECONDS: "300" })).toBe(300);
  });

  it("should refuse a lease when it is not a whole number of at least one", () => {
    expect(() => orchestratorLeaseSeconds({ ORCHESTRATOR_LEASE_SECONDS: "0" })).toThrow(VirtualAgentConfigurationError);
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

describe("publicDomain", () => {
  it("should be preview.platform.hmcts.net when VIRTUAL_AGENT_PUBLIC_DOMAIN is not set", () => {
    expect(publicDomain({})).toBe("preview.platform.hmcts.net");
    expect(publicDomain({ VIRTUAL_AGENT_PUBLIC_DOMAIN: " " })).toBe("preview.platform.hmcts.net");
  });

  it("should be the setting when it is set", () => {
    expect(publicDomain({ VIRTUAL_AGENT_PUBLIC_DOMAIN: " example.net " })).toBe("example.net");
  });
});

describe("gatewaySettings", () => {
  it("should read the APIM subscription key when the deployment is given one", () => {
    expect(gatewaySettings({ AI_GATEWAY_APIM_KEY: " apim-key " })).toEqual({ apim_key: "apim-key" });
  });

  // The pod needs nothing else of the hub: hai resolves the gateway's host, its Entra scope and the apiKeyHelper
  // itself, so a copy of any of them here could only drift from the ones hai uses.
  it("should read nothing but the key when a deployment still sets the gateway's host and scope", () => {
    expect(
      gatewaySettings({
        AI_GATEWAY_APIM_KEY: "apim-key",
        AI_GATEWAY_BASE_URL: "https://ai-gateway.staging.platform.hmcts.net",
        AI_GATEWAY_AUDIENCE: "api://97f4f377-1eda-417b-8367-17c2c64cecd8/.default"
      })
    ).toEqual({ apim_key: "apim-key" });
  });

  // Asked only for an agent on the gateway route that is meant to be running, so this is that pod being refused and
  // not a deployment with nobody on the gateway.
  it.each(["", " "])("should refuse to run a gateway agent naming the setting when the key is %p", (apimKey) => {
    expect(() => gatewaySettings({ AI_GATEWAY_APIM_KEY: apimKey })).toThrow(VirtualAgentConfigurationError);
    expect(() => gatewaySettings({ AI_GATEWAY_APIM_KEY: apimKey })).toThrow("AI_GATEWAY_APIM_KEY");
  });

  it("should refuse to run a gateway agent when the deployment has no gateway configured at all", () => {
    expect(() => gatewaySettings({})).toThrow("AI_GATEWAY_APIM_KEY");
  });
});
