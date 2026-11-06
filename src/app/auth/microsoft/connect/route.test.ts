import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSignIn } from "../../../../auth/entra.ts";
import { SESSION_COOKIE, sealSession } from "../../../../auth/session.ts";

const authorizationUrl = vi.hoisted(() => vi.fn());

vi.mock("@/auth/entra", async () => ({ ...(await import("../../../../auth/entra.ts")), authorizationUrl }));

const { GET, POST } = await import("./route.ts");

const HUB = "https://agent-hub.example";
const SECRET = "a-session-secret-long-enough-to-be-plausible";
const ENV = {
  ENTRA_TENANT_ID: "a-tenant",
  ENTRA_CLIENT_ID: "a-client",
  ENTRA_CLIENT_SECRET: "a-secret",
  ENTRA_REDIRECT_URI: `${HUB}/auth/callback`,
  SESSION_SECRET: SECRET
};

async function connect({
  site = "same-origin",
  origin = HUB,
  signedIn = true,
  aiGateway = true
}: {
  site?: string | null;
  origin?: string | null;
  signedIn?: boolean;
  aiGateway?: boolean;
} = {}) {
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  if (site !== null) {
    headers.set("sec-fetch-site", site);
  }
  if (origin !== null) {
    headers.set("origin", origin);
  }
  if (signedIn) {
    headers.set("cookie", `${SESSION_COOKIE}=${await sealSession({ oid: "an-oid", tid: "a-tenant", name: "A Person", aiGateway }, SECRET)}`);
  }
  return await POST(new NextRequest(`${HUB}/auth/microsoft/connect`, { method: "POST", headers, body: "redirect=%2Fassistant%3Fsettings%3Dconnections" }));
}

beforeEach(() => {
  for (const [name, value] of Object.entries(ENV)) {
    vi.stubEnv(name, value);
  }
  authorizationUrl.mockResolvedValue(new URL("https://login.microsoftonline.com/a-tenant/oauth2/v2.0/authorize?x=1"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("POST /auth/microsoft/connect", () => {
  it("should send the person to Microsoft with a 303 and a sealed connect sign-in when Connect is posted from the hub's own page", async () => {
    const response = await connect();

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("login.microsoftonline.com");
    const cookie = /ah_sign_in=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
    expect(await readSignIn(cookie, SECRET)).toMatchObject({ purpose: "microsoft", returnTo: "/assistant?settings=connections" });
  });

  it.each([
    ["a cross-site form", { site: "cross-site" }],
    ["a same-site but other-origin page", { site: "same-site" }],
    ["an old browser posting from another origin", { site: null, origin: "https://evil.example" }],
    ["a request with neither header", { site: null, origin: null }]
  ])("should refuse %s and start nothing", async (_label, headers) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await connect(headers);

    expect(response.status).toBe(403);
    expect(authorizationUrl).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("should accept an old browser that sends only the hub's own Origin", async () => {
    expect((await connect({ site: null })).status).toBe(303);
  });

  it("should send someone who is not an AI Gateway user back to settings saying it is unavailable, starting nothing", async () => {
    const response = await connect({ aiGateway: false });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/assistant?settings=connections&microsoft=unavailable");
    expect(authorizationUrl).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("should send someone not signed in to sign in first, coming back to settings", async () => {
    const response = await connect({ signedIn: false });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/auth/login?redirect=%2Fassistant%3Fsettings%3Dconnections");
    expect(authorizationUrl).not.toHaveBeenCalled();
  });
});

describe("GET /auth/microsoft/connect", () => {
  it("should start nothing and send a link's visitor to the settings when the address is followed", async () => {
    const response = await GET();

    expect(response.headers.get("location")).toBe("/assistant?settings=connections");
    expect(authorizationUrl).not.toHaveBeenCalled();
  });
});
