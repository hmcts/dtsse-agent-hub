import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { authenticateOrchestrator, ORCHESTRATE_ROLE, verifyOrchestratorToken } from "./orchestrator.ts";
import { AgentAuthConfigurationError, agentAuthSettings } from "./settings.ts";
import { AgentAuthFailed, verifyAgentToken } from "./token.ts";

const TENANT = "531ff96d-0ae9-462a-8d2d-bec7c0b42082";
const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const ORCHESTRATOR = "99999999-0000-0000-0000-00000000000a";
const ENV = { ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT_ID, ORCHESTRATOR_OIDS: `other-oid, ${ORCHESTRATOR}` };
const SETTINGS = agentAuthSettings(ENV);

let keys: ReturnType<typeof createLocalJWKSet>;
let signing: Awaited<ReturnType<typeof generateKeyPair>>;

beforeAll(async () => {
  signing = await generateKeyPair("RS256");
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(signing.publicKey)), kid: "k", alg: "RS256" }] });
});

const APP_ONLY = { oid: ORCHESTRATOR, tid: TENANT, azp: "orchestrator-client-id", roles: [ORCHESTRATE_ROLE] };

async function token(claims: JWTPayload, audience = "api://dtsse-agent-hub"): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k" })
    .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`)
    .setAudience(audience)
    .setExpirationTime("5m")
    .sign(signing.privateKey);
}

function bearer(value: string): Headers {
  return new Headers({ authorization: `Bearer ${value}` });
}

const ROLE_TRUST = { oids: [ORCHESTRATOR], role: ORCHESTRATE_ROLE };
const OID_TRUST = { oids: [ORCHESTRATOR], role: null };

describe("verifyOrchestratorToken", () => {
  it("should take the orchestrator from oid and azp when an app-only token carries the role", async () => {
    expect(await verifyOrchestratorToken(await token(APP_ONLY), SETTINGS, ROLE_TRUST, keys)).toEqual({ oid: ORCHESTRATOR, name: "orchestrator-client-id" });
  });

  it("should accept the client id as the audience when the token names the application that way", async () => {
    await expect(verifyOrchestratorToken(await token(APP_ONLY, CLIENT_ID), SETTINGS, ROLE_TRUST, keys)).resolves.toMatchObject({ oid: ORCHESTRATOR });
  });

  it("should name the orchestrator by its oid when the token has no azp", async () => {
    const { azp: _azp, ...claims } = APP_ONLY;

    expect((await verifyOrchestratorToken(await token(claims), SETTINGS, ROLE_TRUST, keys)).name).toBe(ORCHESTRATOR);
  });

  it.each([
    ["a scope", "agents.access"],
    ["an empty scope", ""],
    ["a scope that is not a string", ["agents.access"]]
  ])("should refuse a token carrying scp when it is %s, even with the role", async (_label, scp) => {
    await expect(verifyOrchestratorToken(await token({ ...APP_ONLY, scp }), SETTINGS, ROLE_TRUST, keys)).rejects.toThrow(/delegated/);
  });

  it.each([
    ["a scope", "agents.access"],
    ["an empty scope", ""]
  ])("should refuse a token carrying scp when it is %s and no role is required", async (_label, scp) => {
    await expect(verifyOrchestratorToken(await token({ ...APP_ONLY, roles: undefined, scp }), SETTINGS, OID_TRUST, keys)).rejects.toThrow(/delegated/);
  });

  it.each([
    ["no roles", { ...APP_ONLY, roles: undefined }],
    ["other roles", { ...APP_ONLY, roles: ["AIGateway.User"] }],
    ["roles that are not a list", { ...APP_ONLY, roles: ORCHESTRATE_ROLE }]
  ])("should refuse an app-only token when a role is required and it has %s", async (_label, claims) => {
    await expect(verifyOrchestratorToken(await token(claims), SETTINGS, ROLE_TRUST, keys)).rejects.toThrow(ORCHESTRATE_ROLE);
  });

  it("should accept an app-only token without roles when no role is required and its oid is trusted", async () => {
    const { roles: _roles, ...claims } = APP_ONLY;

    expect(await verifyOrchestratorToken(await token(claims), SETTINGS, OID_TRUST, keys)).toEqual({ oid: ORCHESTRATOR, name: "orchestrator-client-id" });
  });

  it.each([
    ["the role is required", ROLE_TRUST],
    ["no role is required", OID_TRUST]
  ])("should refuse an app-only token when its oid is not a trusted orchestrator and %s", async (_label, trust) => {
    await expect(verifyOrchestratorToken(await token(APP_ONLY), SETTINGS, { ...trust, oids: ["someone-else"] }, keys)).rejects.toThrow(/not an orchestrator/);
  });

  it("should refuse a token for another tenant when it is otherwise an orchestrator's", async () => {
    await expect(verifyOrchestratorToken(await token({ ...APP_ONLY, tid: "another" }), SETTINGS, OID_TRUST, keys)).rejects.toThrow(/tenant/);
  });

  it("should refuse a token for another audience when no role is required", async () => {
    await expect(verifyOrchestratorToken(await token(APP_ONLY, "api://something-else"), SETTINGS, OID_TRUST, keys)).rejects.toThrow(AgentAuthFailed);
  });
});

describe("the agent API's tokens and the orchestrator's", () => {
  it("should refuse the orchestrator's app-only token when it is presented as an agent's", async () => {
    await expect(verifyAgentToken(await token(APP_ONLY), SETTINGS, keys)).rejects.toThrow(/no scp/);
  });

  it("should still accept a person's delegated token when it is presented as an agent's", async () => {
    await expect(verifyAgentToken(await token({ oid: "a-person", tid: TENANT, scp: "agents.access" }), SETTINGS, keys)).resolves.toMatchObject({
      oid: "a-person"
    });
  });
});

describe("authenticateOrchestrator", () => {
  it("should verify the bearer when agent authentication is on", async () => {
    expect(await authenticateOrchestrator(bearer(await token(APP_ONLY)), ENV, keys)).toMatchObject({ oid: ORCHESTRATOR });
  });

  it("should accept a trusted oid without any role when ORCHESTRATOR_ROLE is unset", async () => {
    const { roles: _roles, ...claims } = APP_ONLY;

    expect(await authenticateOrchestrator(bearer(await token(claims)), ENV, keys)).toMatchObject({ oid: ORCHESTRATOR });
  });

  it("should refuse a trusted oid without the role when ORCHESTRATOR_ROLE is set", async () => {
    const { roles: _roles, ...claims } = APP_ONLY;

    await expect(authenticateOrchestrator(bearer(await token(claims)), { ...ENV, ORCHESTRATOR_ROLE: ORCHESTRATE_ROLE }, keys)).rejects.toThrow(
      ORCHESTRATE_ROLE
    );
  });

  it("should accept a trusted oid with the role when ORCHESTRATOR_ROLE is set", async () => {
    expect(await authenticateOrchestrator(bearer(await token(APP_ONLY)), { ...ENV, ORCHESTRATOR_ROLE: ORCHESTRATE_ROLE }, keys)).toMatchObject({
      oid: ORCHESTRATOR
    });
  });

  it("should refuse a request without a bearer when agent authentication is on", async () => {
    await expect(authenticateOrchestrator(new Headers(), ENV, keys)).rejects.toThrow(AgentAuthFailed);
  });

  it("should be misconfigured when no orchestrator is trusted", async () => {
    await expect(authenticateOrchestrator(bearer(await token(APP_ONLY)), { ...ENV, ORCHESTRATOR_OIDS: " " }, keys)).rejects.toThrow(
      AgentAuthConfigurationError
    );
  });

  it("should take the development orchestrator from its header when agent authentication is disabled", async () => {
    expect(await authenticateOrchestrator(new Headers({ "x-dev-orchestrator": "local" }), { AGENT_AUTH_DISABLED: "true" })).toEqual({
      oid: "dev-orchestrator-local",
      name: "local"
    });
  });

  it.each([
    ["no header", new Headers()],
    ["a malformed name", new Headers({ "x-dev-orchestrator": "a b" })]
  ])("should refuse %s when agent authentication is disabled", async (_label, headers) => {
    await expect(authenticateOrchestrator(headers, { AGENT_AUTH_DISABLED: "true" })).rejects.toThrow(/X-Dev-Orchestrator/);
  });

  it("should refuse the development header on a production build", async () => {
    await expect(
      authenticateOrchestrator(new Headers({ "x-dev-orchestrator": "local" }), { AGENT_AUTH_DISABLED: "true", NODE_ENV: "production" })
    ).rejects.toThrow(AgentAuthConfigurationError);
  });
});
