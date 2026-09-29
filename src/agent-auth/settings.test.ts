import { describe, expect, it } from "vitest";
import { AgentAuthConfigurationError, agentAuthDisabled, agentAuthSettings, DEFAULT_AUDIENCE, jwksUrl } from "./settings.ts";

describe("agentAuthSettings", () => {
  it("should expect the tenant's v2 issuer", () => {
    expect(agentAuthSettings({ ENTRA_TENANT_ID: "a-tenant" }).issuer).toBe("https://login.microsoftonline.com/a-tenant/v2.0");
  });

  it("should accept the default application id URI and the client id when no audience is configured", () => {
    expect(agentAuthSettings({ ENTRA_TENANT_ID: "a-tenant", ENTRA_CLIENT_ID: "a-client" }).audiences).toEqual([DEFAULT_AUDIENCE, "a-client"]);
  });

  it("should read a comma-separated AGENT_API_AUDIENCE and still accept the client id", () => {
    expect(agentAuthSettings({ ENTRA_TENANT_ID: "t", ENTRA_CLIENT_ID: "c", AGENT_API_AUDIENCE: " api://one , api://two ,," }).audiences).toEqual([
      "api://one",
      "api://two",
      "c"
    ]);
  });

  it("should not list the client id twice when it is also the configured audience", () => {
    expect(agentAuthSettings({ ENTRA_TENANT_ID: "t", ENTRA_CLIENT_ID: "c", AGENT_API_AUDIENCE: "c" }).audiences).toEqual(["c"]);
  });

  it("should refuse to start validating when the tenant is not set", () => {
    expect(() => agentAuthSettings({})).toThrow(AgentAuthConfigurationError);
  });

  it("should refuse to start validating when every audience is blank", () => {
    expect(() => agentAuthSettings({ ENTRA_TENANT_ID: "t", AGENT_API_AUDIENCE: " , " })).toThrow(AgentAuthConfigurationError);
  });
});

describe("agentAuthDisabled", () => {
  it.each([
    [{ AGENT_AUTH_DISABLED: "true" }, true],
    [{ AGENT_AUTH_DISABLED: "TRUE" }, false],
    [{ AGENT_AUTH_DISABLED: "1" }, false],
    [{}, false]
  ])("should read %j as %s, so only the exact string disables validation", (env, expected) => {
    expect(agentAuthDisabled(env)).toBe(expected);
  });

  it("should refuse to disable validation when NODE_ENV is production, as it is in the runtime image", () => {
    expect(() => agentAuthDisabled({ AGENT_AUTH_DISABLED: "true", NODE_ENV: "production" })).toThrow(AgentAuthConfigurationError);
  });

  it("should allow the bypass under next dev", () => {
    expect(agentAuthDisabled({ AGENT_AUTH_DISABLED: "true", NODE_ENV: "development" })).toBe(true);
  });

  it("should leave validation on in production when the bypass is not asked for", () => {
    expect(agentAuthDisabled({ NODE_ENV: "production" })).toBe(false);
  });
});

describe("jwksUrl", () => {
  it("should point at the tenant's v2 discovery keys", () => {
    expect(jwksUrl("a-tenant").toString()).toBe("https://login.microsoftonline.com/a-tenant/discovery/v2.0/keys");
  });
});
