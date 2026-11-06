import { describe, expect, it } from "vitest";
import {
  accessTokenView,
  CONNECT_SCOPE,
  connectOutcome,
  GRAPH_PERMISSIONS,
  GRAPH_SCOPE,
  grantedPermissions,
  isConnectOutcome,
  parseSignIn,
  refreshFailure,
  serialiseSignIn,
  withConnectOutcome
} from "./microsoft.ts";

const NOW = Date.parse("2026-12-01T09:00:00.000Z");

describe("GRAPH_SCOPE", () => {
  it("should ask for every Graph permission by its full name and for a refresh token when a refresh is sent", () => {
    const parts = GRAPH_SCOPE.split(" ");
    expect(parts).toContain("offline_access");
    expect(parts).toContain("https://graph.microsoft.com/Mail.Read");
    expect(parts).toHaveLength(GRAPH_PERMISSIONS.length + 1);
  });

  it("should add the identity scopes when the connect sign-in asks, so its id token names the account", () => {
    expect(CONNECT_SCOPE.startsWith("openid profile email ")).toBe(true);
    expect(CONNECT_SCOPE.endsWith(GRAPH_SCOPE)).toBe(true);
  });
});

describe("parseSignIn", () => {
  it("should read back what serialiseSignIn wrote when the value is the hub's own", () => {
    const signIn = { refreshToken: "1.AQ-refresh", account: "a.person@hmcts.net", scope: "Mail.Read offline_access" };
    expect(parseSignIn(serialiseSignIn(signIn))).toEqual(signIn);
  });

  it("should label nobody when the account is missing", () => {
    expect(parseSignIn(JSON.stringify({ refresh_token: "r", scope: "" }))).toEqual({ refreshToken: "r", account: null, scope: "" });
  });

  it.each([
    ["text that is not JSON", "ghp_notjson"],
    ["an array", "[]"],
    ["no refresh token", JSON.stringify({ scope: "Mail.Read" })],
    ["a blank refresh token", JSON.stringify({ refresh_token: " ", scope: "Mail.Read" })],
    ["no scope", JSON.stringify({ refresh_token: "r" })],
    ["a value too long to be one", JSON.stringify({ refresh_token: "r".repeat(20_000), scope: "" })]
  ])("should refuse %s when asked to read a connection", (_label, value) => {
    expect(parseSignIn(value)).toBeUndefined();
  });
});

describe("grantedPermissions", () => {
  it("should name the Graph permissions granted, short and in order, whatever case and prefix Entra writes", () => {
    expect(grantedPermissions("https://graph.microsoft.com/Chat.Read openid mail.read offline_access User.Read")).toEqual(["Mail.Read", "Chat.Read"]);
  });

  it("should name none when nothing was granted", () => {
    expect(grantedPermissions("")).toEqual([]);
  });
});

describe("accessTokenView", () => {
  it("should say when the token stops working, a minute early, when Entra gives its lifetime", () => {
    expect(accessTokenView("eyJ.access", 3600, "Mail.Read", NOW)).toEqual({
      access_token: "eyJ.access",
      expires_at: "2026-12-01T09:59:00.000Z",
      permissions: ["Mail.Read"]
    });
  });

  it("should assume an hour when Entra gives no lifetime", () => {
    expect(accessTokenView("t", undefined, "", NOW).expires_at).toBe("2026-12-01T09:59:00.000Z");
  });

  it("should never give a time in the past when the lifetime is under a minute", () => {
    expect(accessTokenView("t", 30, "", NOW).expires_at).toBe(new Date(NOW).toISOString());
  });
});

describe("refreshFailure", () => {
  it.each(["invalid_grant", "interaction_required", "consent_required"])("should ask for a reconnect when Entra answers %s", (error) => {
    expect(refreshFailure(error)).toBe("reconnect");
  });

  it.each([undefined, "temporarily_unavailable", "server_error"])("should call it unavailable when Entra answers %s", (error) => {
    expect(refreshFailure(error)).toBe("unavailable");
  });
});

describe("connect outcomes", () => {
  it("should read access_denied as a cancelled connect and anything else as a failed one", () => {
    expect(connectOutcome("access_denied")).toBe("cancelled");
    expect(connectOutcome("server_error")).toBe("failed");
  });

  it("should carry the outcome back on the settings address it began on", () => {
    expect(withConnectOutcome("/assistant?settings=connections", "cancelled")).toBe("/assistant?settings=connections&microsoft=cancelled");
    expect(withConnectOutcome("/assistant", "failed")).toBe("/assistant?microsoft=failed");
  });

  it("should know only the two outcomes it words", () => {
    expect(isConnectOutcome("cancelled")).toBe(true);
    expect(isConnectOutcome("failed")).toBe(true);
    expect(isConnectOutcome("unavailable")).toBe(true);
    expect(isConnectOutcome("connected")).toBe(false);
    expect(isConnectOutcome(null)).toBe(false);
  });
});
