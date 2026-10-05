import { describe, expect, it, vi } from "vitest";

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: function DefaultAzureCredential() {
    return { getToken: async () => null };
  }
}));

const { credentialBackend } = await import("./backend.ts");

const DB = { devCredentialValue: {} } as never;
const VAULT = "https://dtsse-ah-creds-aat.vault.azure.net/";

describe("credentialBackend", () => {
  it("should use the vault when CREDENTIALS_VAULT_URL is set, even in production", () => {
    const backend = credentialBackend(DB, { NODE_ENV: "production", CREDENTIALS_VAULT_URL: `${VAULT}\n` });

    expect(backend).toMatchObject({ available: true, store: { acceptsDevIdentities: false } });
  });

  it("should be unavailable when a production build has sign-in off, even with a vault mounted", () => {
    expect(credentialBackend(DB, { NODE_ENV: "production", AUTH_DISABLED: "true", CREDENTIALS_VAULT_URL: VAULT })).toMatchObject({
      available: false,
      reason: expect.stringContaining("sign-in is off")
    });
  });

  it("should keep the local store when sign-in is off outside production", () => {
    expect(credentialBackend(DB, { AUTH_DISABLED: "true", SESSION_SECRET: "s" })).toMatchObject({ available: true });
  });

  it("should reuse one vault client when asked twice for the same vault", () => {
    const first = credentialBackend(DB, { CREDENTIALS_VAULT_URL: VAULT });
    const second = credentialBackend(DB, { CREDENTIALS_VAULT_URL: VAULT });

    expect(first.available && second.available && first.store === second.store).toBe(true);
  });

  it("should build a new vault client when the URL changes", () => {
    const first = credentialBackend(DB, { CREDENTIALS_VAULT_URL: VAULT });
    const second = credentialBackend(DB, { CREDENTIALS_VAULT_URL: "https://another.vault.azure.net/" });

    expect(first.available && second.available && first.store !== second.store).toBe(true);
  });

  it("should be unavailable when the vault URL is not https", () => {
    expect(credentialBackend(DB, { CREDENTIALS_VAULT_URL: "http://dtsse-ah-creds-aat.vault.azure.net/" })).toMatchObject({
      available: false,
      reason: expect.stringContaining("https")
    });
  });

  it("should be unavailable rather than fall back to the database when production has no vault", () => {
    expect(credentialBackend(DB, { NODE_ENV: "production", SESSION_SECRET: "s" })).toMatchObject({
      available: false,
      reason: expect.stringContaining("no credentials vault")
    });
  });

  it("should use the local encrypted store when outside production with a session secret", () => {
    expect(credentialBackend(DB, { NODE_ENV: "development", SESSION_SECRET: "a-secret", CREDENTIALS_VAULT_URL: " " })).toMatchObject({
      available: true,
      store: { acceptsDevIdentities: true }
    });
  });

  it("should be unavailable when outside production without a session secret to key the local store", () => {
    expect(credentialBackend(DB, { NODE_ENV: "development" })).toMatchObject({ available: false, reason: expect.stringContaining("SESSION_SECRET") });
  });
});
