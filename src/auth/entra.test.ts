import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSettings } from "./settings.ts";

const discovery = vi.hoisted(() => vi.fn());
const buildAuthorizationUrl = vi.hoisted(() => vi.fn());
const authorizationCodeGrant = vi.hoisted(() => vi.fn());
const calculatePKCECodeChallenge = vi.hoisted(() => vi.fn());

vi.mock("openid-client", () => ({
  discovery,
  buildAuthorizationUrl,
  authorizationCodeGrant,
  calculatePKCECodeChallenge,
  randomState: () => "a-state",
  randomNonce: () => "a-nonce",
  randomPKCECodeVerifier: () => "a-verifier"
}));

const { authorizationUrl, beginSignIn, completeSignIn, configuration, forgetDiscovery, readSignIn, sealSignIn, SignInFailed, signOutUrl } = await import(
  "./entra.ts"
);

const SETTINGS: AuthSettings = {
  tenantId: "a-tenant",
  clientId: "a-client",
  clientSecret: "a-secret",
  redirectUri: "https://agent-hub.example/auth/callback",
  sessionSecret: "a-session-secret-long-enough-to-be-plausible"
};

/** A discovered configuration carrying whatever server metadata a case needs. */
function discovered(metadata: Record<string, unknown> = {}) {
  return { serverMetadata: () => metadata };
}

beforeEach(() => {
  vi.clearAllMocks();
  forgetDiscovery();
  discovery.mockResolvedValue(discovered());
  calculatePKCECodeChallenge.mockResolvedValue("a-challenge");
  buildAuthorizationUrl.mockImplementation((_config: unknown, params: Record<string, string>) => {
    const url = new URL("https://login.microsoftonline.com/a-tenant/oauth2/v2.0/authorize");
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }
    return url;
  });
});

describe("configuration", () => {
  it("should discover against the tenant's v2 issuer", async () => {
    await configuration(SETTINGS);

    expect(discovery).toHaveBeenCalledWith(new URL("https://login.microsoftonline.com/a-tenant/v2.0"), "a-client", "a-secret");
  });

  it("should discover once and reuse it, rather than once per sign-in", async () => {
    await configuration(SETTINGS);
    await configuration(SETTINGS);

    expect(discovery).toHaveBeenCalledOnce();
  });
});

describe("beginSignIn", () => {
  it("should carry the state, nonce and verifier the callback will be checked against", () => {
    const signIn = beginSignIn("/agents/0f8a");

    expect(signIn).toEqual({ state: "a-state", nonce: "a-nonce", codeVerifier: "a-verifier", returnTo: "/agents/0f8a" });
  });
});

describe("sealSignIn and readSignIn", () => {
  it("should carry a sign-in back out unchanged", async () => {
    const signIn = beginSignIn("/c?topics=pcs-api");

    expect(await readSignIn(await sealSignIn(signIn, SETTINGS.sessionSecret), SETTINGS.sessionSecret)).toEqual(signIn);
  });

  it("should not put the verifier where a browser can read it", async () => {
    expect(await sealSignIn(beginSignIn("/"), SETTINGS.sessionSecret)).not.toContain("a-verifier");
  });

  it("should refuse a cookie sealed under a different secret", async () => {
    const sealed = await sealSignIn(beginSignIn("/"), "another-secret-entirely");

    expect(await readSignIn(sealed, SETTINGS.sessionSecret)).toBeUndefined();
  });

  it.each([
    ["nothing", undefined],
    ["a value that is not a token", "not-a-jwe"]
  ])("should refuse %s, because a callback cannot be checked without it", async (_label, cookie) => {
    expect(await readSignIn(cookie, SETTINGS.sessionSecret)).toBeUndefined();
  });
});

describe("authorizationUrl", () => {
  it("should ask for only the identity scopes, which need no admin consent", async () => {
    const url = await authorizationUrl(SETTINGS, beginSignIn("/"));

    expect(url.searchParams.get("scope")).toBe("openid profile email");
  });

  it("should carry the redirect uri, state and nonce", async () => {
    const url = await authorizationUrl(SETTINGS, beginSignIn("/"));

    expect(url.searchParams.get("redirect_uri")).toBe(SETTINGS.redirectUri);
    expect(url.searchParams.get("state")).toBe("a-state");
    expect(url.searchParams.get("nonce")).toBe("a-nonce");
  });

  it("should use PKCE with S256, never the verifier itself", async () => {
    const url = await authorizationUrl(SETTINGS, beginSignIn("/"));

    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("a-challenge");
    expect(url.toString()).not.toContain("a-verifier");
  });
});

describe("completeSignIn", () => {
  const CURRENT = new URL("https://agent-hub.example/auth/callback?code=a-code&state=a-state");
  const IDENTITY = { oid: "0000-oid", tid: "a-tenant", sub: "pairwise-subject", name: "A Person" };

  function granted(claims: Record<string, unknown> | undefined) {
    authorizationCodeGrant.mockResolvedValue({ claims: () => claims });
  }

  it("should check the state, nonce and verifier it was given", async () => {
    granted(IDENTITY);

    await completeSignIn(SETTINGS, CURRENT, beginSignIn("/"));

    expect(authorizationCodeGrant).toHaveBeenCalledWith(expect.anything(), CURRENT, {
      expectedState: "a-state",
      expectedNonce: "a-nonce",
      pkceCodeVerifier: "a-verifier"
    });
  });

  it("should key the session by oid and tid rather than the pairwise sub, so it matches the person's az token", async () => {
    granted({ ...IDENTITY, email: "a.person@justice.gov.uk" });

    expect(await completeSignIn(SETTINGS, CURRENT, beginSignIn("/"))).toEqual({
      oid: "0000-oid",
      tid: "a-tenant",
      name: "A Person",
      email: "a.person@justice.gov.uk",
      aiGateway: false
    });
  });

  it.each([
    ["the AI gateway role among others", ["Something.Else", "AIGateway.User"], true],
    ["only another role", ["Something.Else"], false],
    ["the role in another case", ["aigateway.user"], false],
    ["roles that are not a list", "AIGateway.User", false],
    ["no roles claim", undefined, false]
  ])("should record the AIGateway.User role when the id token carries %s", async (_label, roles, expected) => {
    granted({ ...IDENTITY, ...(roles === undefined ? {} : { roles }) });

    expect((await completeSignIn(SETTINGS, CURRENT, beginSignIn("/"))).aiGateway).toBe(expected);
  });

  it("should take the email from preferred_username when the email claim is absent", async () => {
    granted({ ...IDENTITY, preferred_username: "a.person@justice.gov.uk" });

    expect((await completeSignIn(SETTINGS, CURRENT, beginSignIn("/"))).email).toBe("a.person@justice.gov.uk");
  });

  it("should fall back to the email and then the oid when Entra returns no display name", async () => {
    granted({ oid: "0000-oid", tid: "a-tenant", email: "a@b.c" });
    expect((await completeSignIn(SETTINGS, CURRENT, beginSignIn("/"))).name).toBe("a@b.c");

    granted({ oid: "0000-oid", tid: "a-tenant" });
    const session = await completeSignIn(SETTINGS, CURRENT, beginSignIn("/"));
    expect(session.name).toBe("0000-oid");
    expect(session.email).toBeUndefined();
  });

  it.each([
    ["no claims at all", undefined],
    ["a sub but no oid", { sub: "pairwise-subject", tid: "a-tenant" }],
    ["an oid but no tid", { oid: "0000-oid" }],
    ["an empty oid", { oid: "", tid: "a-tenant" }]
  ])("should refuse an id token with %s, since there is no identity to hold a session for", async (_label, claims) => {
    granted(claims);

    await expect(completeSignIn(SETTINGS, CURRENT, beginSignIn("/"))).rejects.toThrow(SignInFailed);
  });

  it("should refuse an id token from another tenant", async () => {
    granted({ ...IDENTITY, tid: "another-tenant" });

    await expect(completeSignIn(SETTINGS, CURRENT, beginSignIn("/"))).rejects.toThrow(/another-tenant/);
  });

  it("should turn a rejected grant into SignInFailed rather than leaking the library's error out", async () => {
    authorizationCodeGrant.mockRejectedValue(new Error("state mismatch"));

    await expect(completeSignIn(SETTINGS, CURRENT, beginSignIn("/"))).rejects.toThrow(SignInFailed);
  });

  it("should carry a thrown non-error into SignInFailed too", async () => {
    authorizationCodeGrant.mockRejectedValue("a string");

    await expect(completeSignIn(SETTINGS, CURRENT, beginSignIn("/"))).rejects.toThrow("a string");
  });
});

describe("signOutUrl", () => {
  it("should send the reader to Entra's end session endpoint, with no return uri to be ignored", async () => {
    discovery.mockResolvedValue(discovered({ end_session_endpoint: "https://login.microsoftonline.com/a-tenant/oauth2/v2.0/logout" }));

    const url = await signOutUrl(SETTINGS);

    expect(url?.origin).toBe("https://login.microsoftonline.com");
    expect(url?.searchParams.get("post_logout_redirect_uri")).toBeNull();
  });

  it("should say so when the tenant advertises no end session endpoint, rather than inventing one", async () => {
    expect(await signOutUrl(SETTINGS)).toBeUndefined();
  });
});

describe("discovery failure", () => {
  it("should not cache a rejection, or one blip poisons every later sign-in", async () => {
    discovery.mockRejectedValueOnce(new Error("getaddrinfo EAI_AGAIN login.microsoftonline.com"));

    await expect(configuration(SETTINGS)).rejects.toThrow("EAI_AGAIN");

    discovery.mockResolvedValue(discovered());
    await expect(configuration(SETTINGS)).resolves.toBeDefined();
    expect(discovery).toHaveBeenCalledTimes(2);
  });
});
