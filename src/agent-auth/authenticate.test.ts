import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { authenticateAgent } from "./authenticate.ts";
import { parseDevUser } from "./dev.ts";
import { AgentAuthFailed } from "./token.ts";

const TENANT = "a-tenant";

describe("authenticateAgent", () => {
  it("should take the developer from X-Dev-User when agent auth is disabled", async () => {
    const headers = new Headers({ "x-dev-user": "dev-oid|Dev Person|dev@example.com" });

    expect(await authenticateAgent(headers, { AGENT_AUTH_DISABLED: "true" })).toEqual({
      oid: "dev-oid",
      tid: "dev",
      name: "Dev Person",
      email: "dev@example.com"
    });
  });

  it("should refuse a request with no X-Dev-User when agent auth is disabled, rather than invent a caller", async () => {
    await expect(authenticateAgent(new Headers({ authorization: "Bearer x" }), { AGENT_AUTH_DISABLED: "true" })).rejects.toThrow(/X-Dev-User/);
  });

  it("should ignore X-Dev-User when agent auth is enabled", async () => {
    const headers = new Headers({ "x-dev-user": "dev-oid|Dev Person" });

    await expect(authenticateAgent(headers, { ENTRA_TENANT_ID: TENANT })).rejects.toThrow(/Bearer/);
  });

  it("should refuse a malformed Authorization header", async () => {
    await expect(authenticateAgent(new Headers({ authorization: "Basic abc" }), { ENTRA_TENANT_ID: TENANT })).rejects.toThrow(AgentAuthFailed);
  });

  it("should verify a bearer token when agent auth is enabled", async () => {
    const pair = await generateKeyPair("RS256");
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k", alg: "RS256" }] });
    const jwt = await new SignJWT({ oid: "an-oid", tid: TENANT, name: "A" })
      .setProtectedHeader({ alg: "RS256", kid: "k" })
      .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`)
      .setAudience("api://dtsse-agent-hub")
      .setExpirationTime("5m")
      .sign(pair.privateKey);

    const identity = await authenticateAgent(new Headers({ authorization: `Bearer ${jwt}` }), { ENTRA_TENANT_ID: TENANT }, keys);

    expect(identity.oid).toBe("an-oid");
  });
});

describe("parseDevUser", () => {
  it("should accept an identity without an email", () => {
    expect(parseDevUser("oid|Name")).toEqual({ oid: "oid", tid: "dev", name: "Name" });
  });

  it.each([
    ["nothing", undefined],
    ["an empty header", ""],
    ["an oid alone", "oid"],
    ["an empty name", "oid||a@b.c"],
    ["too many parts", "oid|Name|a@b.c|extra"]
  ])("should refuse %s", (_label, header) => {
    expect(parseDevUser(header)).toBeUndefined();
  });
});
