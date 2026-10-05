import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { authenticateAgent } from "./authenticate.ts";
import { parseDevUser } from "./dev.ts";
import { AgentAuthConfigurationError } from "./settings.ts";
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

  it("should refuse the development header when agent auth is disabled on a production build", async () => {
    const headers = new Headers({ "x-dev-user": "dev-oid|Dev Person" });

    await expect(authenticateAgent(headers, { AGENT_AUTH_DISABLED: "true", NODE_ENV: "production" })).rejects.toThrow(AgentAuthConfigurationError);
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
    const jwt = await new SignJWT({ oid: "an-oid", tid: TENANT, name: "A", scp: "user_impersonation" })
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
    expect(parseDevUser("dev-oid|Name")).toEqual({ oid: "dev-oid", tid: "dev", name: "Name" });
  });

  it("should prefix the oid with dev- when it does not already have it, so the header cannot name a real person", () => {
    expect(parseDevUser("a1b2c3d4-0000-0000-0000-000000000001|Name")?.oid).toBe("dev-a1b2c3d4-0000-0000-0000-000000000001");
  });

  it("should keep a dev- oid as it is when it names a UI persona", () => {
    expect(parseDevUser("dev-alice|Dev alice (sign-in disabled)|alice@dev.invalid")?.oid).toBe("dev-alice");
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

describe("authenticateAgent with a launch token", () => {
  const TOKEN = `ahv_${"A".repeat(43)}`;
  const OWNER = { oid: "dev-alice", tid: "dev", name: "Alice", virtualAgentId: "va-1" };

  it("should act as the virtual agent's owner when virtual agents are on and the token resolves", async () => {
    const resolve = async (token: string) => (token === TOKEN ? OWNER : undefined);

    expect(
      await authenticateAgent(
        new Headers({ authorization: `Bearer ${TOKEN}` }),
        { VIRTUAL_AGENTS_ENABLED: "true", ENTRA_TENANT_ID: TENANT },
        undefined,
        resolve
      )
    ).toEqual(OWNER);
  });

  it("should accept a launch token when agent authentication is disabled too, since a pod has no other identity", async () => {
    expect(
      await authenticateAgent(
        new Headers({ authorization: `Bearer ${TOKEN}` }),
        { VIRTUAL_AGENTS_ENABLED: "true", AGENT_AUTH_DISABLED: "true" },
        undefined,
        async () => OWNER
      )
    ).toEqual(OWNER);
  });

  it("should refuse a launch token when it resolves to nobody", async () => {
    await expect(
      authenticateAgent(
        new Headers({ authorization: `Bearer ${TOKEN}` }),
        { VIRTUAL_AGENTS_ENABLED: "true", ENTRA_TENANT_ID: TENANT },
        undefined,
        async () => undefined
      )
    ).rejects.toThrow(/launch token was refused/);
  });

  it("should not look a launch token up when virtual agents are off", async () => {
    let looked = false;
    const resolve = async () => {
      looked = true;
      return OWNER;
    };

    await expect(authenticateAgent(new Headers({ authorization: `Bearer ${TOKEN}` }), { ENTRA_TENANT_ID: TENANT }, undefined, resolve)).rejects.toThrow(
      AgentAuthFailed
    );
    expect(looked).toBe(false);
  });

  it("should still refuse a production build with agent authentication disabled when a launch token is sent", async () => {
    await expect(
      authenticateAgent(
        new Headers({ authorization: `Bearer ${TOKEN}` }),
        { VIRTUAL_AGENTS_ENABLED: "true", AGENT_AUTH_DISABLED: "true", NODE_ENV: "production" },
        undefined,
        async () => OWNER
      )
    ).rejects.toThrow(AgentAuthConfigurationError);
  });
});
