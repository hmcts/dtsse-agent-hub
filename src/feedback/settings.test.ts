import { describe, expect, it } from "vitest";
import { feedbackBlobSettings, feedbackEnabled, feedbackSignInOrigins } from "./settings.ts";

const VIEWER = {
  AGENT_HUB_VIEWER_HOST: "agent-hub-viewer.aat.platform.hmcts.net",
  ENTRA_REDIRECT_URI: "https://agent-hub.aat.platform.hmcts.net/auth/callback",
  SESSION_SECRET: "s".repeat(32)
};
const ACCOUNT = "https://dtsseagenthubaat.blob.core.windows.net";
const AZURITE = "UseDevelopmentStorage=true";

describe("feedbackBlobSettings", () => {
  it("should use the managed identity against the account when only its URL is set", () => {
    expect(feedbackBlobSettings({ FEEDBACK_STORAGE_ACCOUNT_URL: ` ${ACCOUNT}/ ` })).toEqual({ kind: "identity", accountUrl: ACCOUNT, container: "feedback" });
  });

  it("should prefer a connection string when one is set", () => {
    expect(
      feedbackBlobSettings({ FEEDBACK_STORAGE_ACCOUNT_URL: ACCOUNT, FEEDBACK_STORAGE_CONNECTION_STRING: AZURITE, FEEDBACK_STORAGE_CONTAINER: "local-feedback" })
    ).toEqual({
      kind: "connection",
      connectionString: AZURITE,
      container: "local-feedback"
    });
  });

  it.each([
    ["nothing is set", {}],
    ["the account URL is not https", { FEEDBACK_STORAGE_ACCOUNT_URL: "http://account.blob.core.windows.net" }],
    ["the account URL carries a query", { FEEDBACK_STORAGE_ACCOUNT_URL: `${ACCOUNT}?sv=1` }],
    ["the account URL is not a URL", { FEEDBACK_STORAGE_ACCOUNT_URL: "account" }],
    ["the container name is one Azure refuses", { FEEDBACK_STORAGE_ACCOUNT_URL: ACCOUNT, FEEDBACK_STORAGE_CONTAINER: "Feedback--x" }]
  ])("should answer none when %s", (_label, env) => {
    expect(feedbackBlobSettings(env)).toBeUndefined();
  });
});

describe("feedbackEnabled", () => {
  it("should be on when the flag, the viewer and the storage are all set", () => {
    expect(feedbackEnabled({ ...VIEWER, FEEDBACK_ENABLED: "true", FEEDBACK_STORAGE_ACCOUNT_URL: ACCOUNT })).toBe(true);
  });

  it.each([
    ["the flag is not exactly true", { ...VIEWER, FEEDBACK_ENABLED: "yes", FEEDBACK_STORAGE_ACCOUNT_URL: ACCOUNT }],
    ["the viewer is off", { FEEDBACK_ENABLED: "true", FEEDBACK_STORAGE_ACCOUNT_URL: ACCOUNT }],
    ["there is no storage", { ...VIEWER, FEEDBACK_ENABLED: "true" }]
  ])("should be off when %s", (_label, env) => {
    expect(feedbackEnabled(env)).toBe(false);
  });
});

describe("feedbackSignInOrigins", () => {
  it("should read each https origin once, normalised", () => {
    const env = { NODE_ENV: "production", FEEDBACK_SIGN_IN_ORIGINS: " https://IDAM.example/ , https://idam.example,https://other.example" };
    expect(feedbackSignInOrigins(env)).toEqual(["https://idam.example", "https://other.example"]);
  });

  it("should leave out what a link's origin could not be, or anything with a path", () => {
    const env = { NODE_ENV: "production", FEEDBACK_SIGN_IN_ORIGINS: "http://idam.example,https://10.0.0.1,https://idam.example/login,not a url" };
    expect(feedbackSignInOrigins(env)).toEqual([]);
  });

  it("should be empty when unset", () => {
    expect(feedbackSignInOrigins({})).toEqual([]);
  });
});
