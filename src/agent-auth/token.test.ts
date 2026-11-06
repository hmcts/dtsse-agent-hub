import { createLocalJWKSet, errors, exportJWK, generateKeyPair, type JWTPayload, type JWTVerifyGetKey, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { type AgentAuthSettings, agentAuthSettings } from "./settings.ts";
import { AgentAuthFailed, AgentAuthUnavailable, tenantKeys, verifyAgentToken } from "./token.ts";

const TENANT = "531ff96d-0ae9-462a-8d2d-bec7c0b42082";
const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const SETTINGS: AgentAuthSettings = agentAuthSettings({ ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT_ID });

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let signing: KeyPair;
let stranger: KeyPair;
let keys: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  signing = await generateKeyPair("RS256");
  stranger = await generateKeyPair("RS256");
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(signing.publicKey)), kid: "tenant-key", alg: "RS256" }] });
});

const CLAIMS = {
  oid: "a1b2c3d4-0000-0000-0000-000000000001",
  tid: TENANT,
  name: "Alice Smith",
  preferred_username: "alice.smith@justice.gov.uk",
  scp: "user_impersonation"
};

async function token(
  overrides: JWTPayload = {},
  options: { key?: KeyPair; issuer?: string; audience?: string; expiresIn?: string | number; kid?: string } = {}
): Promise<string> {
  const jwt = new SignJWT({ ...CLAIMS, ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: options.kid ?? "tenant-key" })
    .setIssuedAt()
    .setIssuer(options.issuer ?? `https://login.microsoftonline.com/${TENANT}/v2.0`)
    .setAudience(options.audience ?? CLIENT_ID)
    .setExpirationTime(options.expiresIn ?? "1h");
  return await jwt.sign((options.key ?? signing).privateKey);
}

describe("verifyAgentToken", () => {
  it("should take the identity from oid, name and preferred_username when the token is valid", async () => {
    expect(await verifyAgentToken(await token(), SETTINGS, keys)).toEqual({
      oid: CLAIMS.oid,
      tid: TENANT,
      name: "Alice Smith",
      email: "alice.smith@justice.gov.uk"
    });
  });

  it("should accept the application id URI as the audience as well as the client id", async () => {
    await expect(verifyAgentToken(await token({}, { audience: "api://dtsse-agent-hub" }), SETTINGS, keys)).resolves.toMatchObject({ oid: CLAIMS.oid });
  });

  it("should refuse a token for another audience", async () => {
    await expect(verifyAgentToken(await token({}, { audience: "https://management.azure.com" }), SETTINGS, keys)).rejects.toThrow(AgentAuthFailed);
  });

  it("should refuse a v1 issuer, since the registration only issues v2 tokens", async () => {
    await expect(verifyAgentToken(await token({}, { issuer: `https://sts.windows.net/${TENANT}/` }), SETTINGS, keys)).rejects.toThrow(AgentAuthFailed);
  });

  it("should refuse a token issued by another tenant's issuer", async () => {
    const other = "99999999-9999-9999-9999-999999999999";
    await expect(verifyAgentToken(await token({ tid: other }, { issuer: `https://login.microsoftonline.com/${other}/v2.0` }), SETTINGS, keys)).rejects.toThrow(
      AgentAuthFailed
    );
  });

  it("should refuse a token whose tid disagrees with its issuer", async () => {
    await expect(verifyAgentToken(await token({ tid: "99999999-9999-9999-9999-999999999999" }), SETTINGS, keys)).rejects.toThrow(/tenant/);
  });

  it("should refuse an expired token beyond the clock tolerance", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    await expect(verifyAgentToken(await token({ iat: past - 60 }, { expiresIn: past }), SETTINGS, keys)).rejects.toThrow(AgentAuthFailed);
  });

  it("should refuse a token signed by a key the tenant does not publish", async () => {
    await expect(verifyAgentToken(await token({}, { key: stranger }), SETTINGS, keys)).rejects.toThrow(AgentAuthFailed);
  });

  it("should refuse a token with no oid", async () => {
    await expect(verifyAgentToken(await token({ oid: undefined }), SETTINGS, keys)).rejects.toThrow(AgentAuthFailed);
  });

  it("should refuse a token whose oid is empty", async () => {
    await expect(verifyAgentToken(await token({ oid: "" }), SETTINGS, keys)).rejects.toThrow(/oid/);
  });

  it("should refuse something that is not a token", async () => {
    await expect(verifyAgentToken("not-a-jwt", SETTINGS, keys)).rejects.toThrow(AgentAuthFailed);
  });

  it.each([
    ["an app-only token, which carries roles instead", { scp: undefined, roles: ["Agent.ReadWrite"] }],
    ["an ID token, which has no scp", { scp: undefined }],
    ["a token whose scp is empty", { scp: "" }],
    ["a token whose scp is not a string", { scp: ["user_impersonation"] }]
  ])("should refuse %s", async (_label, overrides) => {
    await expect(verifyAgentToken(await token(overrides), SETTINGS, keys)).rejects.toThrow(/scp/);
  });

  it.each([
    ["the key set fetch times out", new errors.JWKSTimeout()],
    ["the network fails", new TypeError("fetch failed")],
    ["the endpoint does not answer 200", new errors.JOSEError("Expected 200 OK from the JSON Web Key Set HTTP response")],
    ["the key set is malformed", new errors.JWKSInvalid("JSON Web Key Set malformed")]
  ])("should report the keys as unavailable rather than the token as bad when %s", async (_label, failure) => {
    const failing: JWTVerifyGetKey = async () => {
      throw failure;
    };

    await expect(verifyAgentToken(await token(), SETTINGS, failing)).rejects.toThrow(AgentAuthUnavailable);
  });

  it("should still refuse the token when the key set has no key it names", async () => {
    const rejection = verifyAgentToken(await token({}, { kid: "unpublished" }), SETTINGS, keys);

    await expect(rejection).rejects.toThrow(AgentAuthFailed);
    await expect(rejection).rejects.not.toThrow(AgentAuthUnavailable);
  });

  it("should fall back to the email claim and then the oid for display when name is missing", async () => {
    const identity = await verifyAgentToken(await token({ name: undefined, preferred_username: undefined, email: "a@b.c" }), SETTINGS, keys);
    expect(identity).toMatchObject({ name: "a@b.c", email: "a@b.c" });

    const bare = await verifyAgentToken(await token({ name: undefined, preferred_username: undefined }), SETTINGS, keys);
    expect(bare.name).toBe(CLAIMS.oid);
    expect(bare.email).toBeUndefined();
  });
});

describe("tenantKeys", () => {
  it("should reuse the key set for the same tenant, so the JWKS cache survives between requests", () => {
    expect(tenantKeys(TENANT)).toBe(tenantKeys(TENANT));
  });

  it("should build a new key set when the tenant changes", () => {
    const first = tenantKeys(TENANT);
    expect(tenantKeys("another-tenant")).not.toBe(first);
  });
});
