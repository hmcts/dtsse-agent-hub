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
  const GATEWAY = {
    AI_GATEWAY_BASE_URL: "https://ai-gateway.sandbox.platform.hmcts.net",
    AI_GATEWAY_AUDIENCE: "api://b3bfa0f5-faa5-4d10-bba0-e284144aea89/.default",
    AI_GATEWAY_APIM_KEY: "apim-key"
  };

  it("should read the gateway when all three settings are given", () => {
    expect(gatewaySettings(GATEWAY)).toEqual({
      base_url: GATEWAY.AI_GATEWAY_BASE_URL,
      audience: GATEWAY.AI_GATEWAY_AUDIENCE,
      apim_key: "apim-key"
    });
  });

  it("should drop a trailing slash from the base URL when one is given, since the pod appends a path to it", () => {
    expect(gatewaySettings({ ...GATEWAY, AI_GATEWAY_BASE_URL: "https://ai-gateway.sandbox.platform.hmcts.net//" })?.base_url).toBe(
      "https://ai-gateway.sandbox.platform.hmcts.net"
    );
  });

  it("should have no gateway when none of the three is set, since a deployment without one is not misconfigured", () => {
    expect(gatewaySettings({})).toBeNull();
    expect(gatewaySettings({ AI_GATEWAY_BASE_URL: " ", AI_GATEWAY_AUDIENCE: "", AI_GATEWAY_APIM_KEY: " " })).toBeNull();
  });

  // Half-configured is a pod that boots and then fails every turn, so the claim is refused rather than served.
  it.each(["AI_GATEWAY_BASE_URL", "AI_GATEWAY_AUDIENCE", "AI_GATEWAY_APIM_KEY"] as const)(
    "should refuse the deployment naming the one missing setting when %s is left out",
    (missing) => {
      const { [missing]: _left, ...rest } = GATEWAY;

      expect(() => gatewaySettings(rest)).toThrow(VirtualAgentConfigurationError);
      expect(() => gatewaySettings(rest)).toThrow(missing);
    }
  );

  // A wrong audience is a bare `401 invalid_token` at the gateway, which says nothing about what was wrong — and one
  // with a quote, a backtick or a `$(…)` in it is interpolated into a double-quoted shell string in the pod's token
  // helper, where a shell would act on it rather than ask for a scope by that name.
  it.each([
    "b3bfa0f5",
    "api://b3bfa0f5",
    "https://gateway/.default",
    'api://gw"/.default',
    "api://gw`id`/.default",
    "api://gw$(id)/.default",
    "api://gw'/.default",
    "api://gw;id/.default"
  ])("should refuse %s as the gateway's scope", (audience) => {
    expect(() => gatewaySettings({ ...GATEWAY, AI_GATEWAY_AUDIENCE: audience })).toThrow("AI_GATEWAY_AUDIENCE");
  });

  it("should refuse a base URL that is not http or https", () => {
    expect(() => gatewaySettings({ ...GATEWAY, AI_GATEWAY_BASE_URL: "ai-gateway.sandbox.platform.hmcts.net" })).toThrow("AI_GATEWAY_BASE_URL");
  });

  it("should never put the APIM key in the refusal, because it is logged and answered with", () => {
    expect(() => gatewaySettings({ AI_GATEWAY_APIM_KEY: "apim-key" })).toThrow(expect.not.stringContaining("apim-key"));
  });
});
