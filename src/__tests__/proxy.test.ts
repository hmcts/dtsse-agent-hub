import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, sealSession } from "@/auth/session";
import { config, proxy } from "@/proxy";

const SECRET = "a-test-session-secret-long-enough-to-be-plausible";
const PERSON = { oid: "abc", tid: "tenant", name: "A Person", aiGateway: false };

function ask(url: string, cookies: Record<string, string> = {}): NextRequest {
  const request = new NextRequest(new URL(url, "https://agent-hub.example"));
  for (const [name, value] of Object.entries(cookies)) {
    request.cookies.set(name, value);
  }
  return request;
}

describe("proxy sign-in guard", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_DISABLED", "");
    vi.stubEnv("SESSION_SECRET", SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should send a person with no session to sign in", async () => {
    const response = await proxy(ask("/"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/auth/login");
  });

  it("should carry the path and query through the sign-in, so a shared channel link survives it", async () => {
    const response = await proxy(ask("/hub/c?topics=pcs-api,database&mode=any"));

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("redirect")).toBe("/hub/c?topics=pcs-api,database&mode=any");
  });

  it("should let a person with a valid session through", async () => {
    const cookie = await sealSession(PERSON, SECRET);

    expect((await proxy(ask("/", { [SESSION_COOKIE]: cookie }))).status).toBe(200);
  });

  it("should refuse a session sealed under a different secret", async () => {
    const cookie = await sealSession(PERSON, "a-different-secret-entirely");

    expect((await proxy(ask("/", { [SESSION_COOKIE]: cookie }))).status).toBe(307);
  });

  it.each(["/health", "/health/liveness", "/health/readiness"])("should let the probe path %s through unauthenticated", async (path) => {
    expect((await proxy(ask(path))).status).toBe(200);
  });

  it("should let the sign-in routes through, or nobody could ever obtain a session", async () => {
    expect((await proxy(ask("/auth/login"))).status).toBe(200);
    expect((await proxy(ask("/auth/callback?code=x&state=y"))).status).toBe(200);
  });

  it("should let the agent API through to its own bearer check rather than redirect an agent to Microsoft", async () => {
    expect((await proxy(ask("/api/agent/register"))).status).toBe(200);
  });

  it.each([
    "/api/ui/stream?topics=a",
    "/api/ui/feed?topics=a&before=5",
    "/api/ui/topics?prefix=p",
    "/api/ui/session"
  ])("should let %s through to its own 401 rather than redirect a fetch or EventSource to sign in when there is no session", async (path) => {
    expect((await proxy(ask(path))).status).toBe(200);
  });

  it("should let a UI request through to its own 401 when the session has expired", async () => {
    const cookie = await sealSession(PERSON, "a-different-secret-entirely");

    expect((await proxy(ask("/api/ui/session", { [SESSION_COOKIE]: cookie }))).status).toBe(200);
  });

  it("should send a person to sign in when the session secret is missing entirely", async () => {
    vi.stubEnv("SESSION_SECRET", "");

    expect((await proxy(ask("/"))).status).toBe(307);
  });

  it("should let everything through when authentication is disabled", async () => {
    vi.stubEnv("AUTH_DISABLED", "true");

    expect((await proxy(ask("/"))).status).toBe(200);
  });
});

describe("proxy matcher", () => {
  it("should run for pages and not for the build's own assets", () => {
    const [matcher] = config.matcher;
    const pattern = new RegExp(`^${matcher}$`);
    expect(pattern.test("/")).toBe(true);
    expect(pattern.test("/hub/c")).toBe(true);
    expect(pattern.test("/_next/static/chunks/main.js")).toBe(false);
  });
});

function askWith(method: string, url: string): NextRequest {
  return new NextRequest(new URL(url, "https://agent-hub.example"), { method });
}

describe("proxy secret-in-query guard", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_DISABLED", "");
    vi.stubEnv("SESSION_SECRET", SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    "value",
    "token",
    "code",
    "password",
    "secret",
    "Value",
    "TOKEN"
  ])("should redirect 303 to the bare path when a GET carries a %s parameter", async (name) => {
    const response = await proxy(askWith("GET", `/hub/virtual/va-1?kind=jenkins&${name}=11a2b3c4d5e6f708192a3b4c5d`));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://agent-hub.example/hub/virtual/va-1");
  });

  it("should redirect a HEAD that carries a secret parameter too", async () => {
    expect((await proxy(askWith("HEAD", "/hub/agents/va-1?value=x"))).status).toBe(303);
  });

  it("should refuse the secret before the sign-in redirect, which would otherwise copy it into redirect=", async () => {
    const response = await proxy(askWith("GET", "/hub/agents/va-1?value=a-pasted-token"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).not.toContain("a-pasted-token");
  });

  it("should refuse the secret even when sign-in is disabled", async () => {
    vi.stubEnv("AUTH_DISABLED", "true");

    expect((await proxy(askWith("GET", "/hub/settings/credentials?token=x"))).status).toBe(303);
  });

  // The bare addresses redirect to `/hub`, and that redirect sits below this guard on purpose: run above it, or from
  // `redirects()` in next.config.mjs, it would answer with a `Location` repeating the secret.
  it.each([
    "/settings/credentials?token=sk-ant-0000000000000000000000",
    "/agents/va-1?value=a-pasted-token",
    "/virtual/va-1?kind=jenkins&code=11a2b3c4d5e6f708192a3b4c5d",
    "/settings/credentials?TOKEN=sk-ant-0000000000000000000000"
  ])("should strip the secret from %s before redirecting it under /hub", async (path) => {
    vi.stubEnv("AUTH_DISABLED", "true");

    const response = await proxy(askWith("GET", path));

    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location).toBe(`https://agent-hub.example${path.split("?")[0]}`);
    expect(location).not.toContain("?");
  });

  it("should let the OpenID Connect callback keep its authorisation code", async () => {
    expect((await proxy(askWith("GET", "/auth/callback?code=x&state=y"))).status).toBe(200);
  });

  it("should leave a POST alone when it is a form posted to the page", async () => {
    vi.stubEnv("AUTH_DISABLED", "true");

    expect((await proxy(askWith("POST", "/hub/agents/va-1?value=x"))).status).toBe(200);
  });

  it.each([
    "/hub/agents/va-1?kind=jenkins",
    "/hub/c?topics=pcs-api,database&mode=any",
    "/api/ui/feed?topics=a&before=5",
    "/api/ui/stream?topics=a&after=3",
    "/api/ui/topics?prefix=p",
    "/hub/topics?q=pcs",
    "/hub/agents/va-1?values=x&codes=y"
  ])("should let %s through when it carries no secret parameter", async (path) => {
    vi.stubEnv("AUTH_DISABLED", "true");

    expect((await proxy(askWith("GET", path))).status).toBe(200);
  });
});

describe("proxy hub address redirect", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_DISABLED", "true");
    vi.stubEnv("SESSION_SECRET", SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["/access", "/hub/access"],
    ["/agents/0f8a", "/hub/agents/0f8a"],
    ["/c", "/hub/c"],
    ["/channels/new", "/hub/channels/new"],
    ["/m/42", "/hub/m/42"],
    ["/settings/credentials", "/hub/settings/credentials"],
    ["/topics", "/hub/topics"],
    ["/topics/pcs-api", "/hub/topics/pcs-api"],
    ["/virtual", "/hub/virtual"],
    ["/virtual/0f8a", "/hub/virtual/0f8a"]
  ])("should redirect the bare address %s to %s", async (from, to) => {
    const response = await proxy(askWith("GET", from));

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`https://agent-hub.example${to}`);
  });

  it("should keep the query when it carries no secret, so a shared channel view survives the redirect", async () => {
    const response = await proxy(askWith("GET", "/c?topics=pcs-api,database&mode=all"));

    expect(response.headers.get("location")).toBe("https://agent-hub.example/hub/c?topics=pcs-api,database&mode=all");
  });

  it.each([
    "/",
    "/hub",
    "/hub/topics",
    "/assistant",
    "/assistant/abc",
    "/auth/login",
    "/api/ui/feed",
    "/health",
    "/topicsfoo"
  ])("should leave %s alone, so the front door and the moved pages themselves never redirect", async (path) => {
    expect((await proxy(askWith("GET", path))).status).toBe(200);
  });

  it("should redirect before the sign-in check, so the login's redirect= carries the new address", async () => {
    vi.stubEnv("AUTH_DISABLED", "");

    const response = await proxy(askWith("GET", "/topics/pcs-api"));

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://agent-hub.example/hub/topics/pcs-api");
  });
});

describe("proxy for the viewer's host", () => {
  const VIEWER = "agent-hub-viewer.example";

  function onHost(host: string, path: string, method = "GET"): NextRequest {
    return new NextRequest(new URL(path, `https://${host}`), { method, headers: { host } });
  }

  beforeEach(() => {
    vi.stubEnv("AUTH_DISABLED", "");
    vi.stubEnv("SESSION_SECRET", SECRET);
    vi.stubEnv("AGENT_HUB_VIEWER_HOST", VIEWER);
    vi.stubEnv("ENTRA_REDIRECT_URI", "https://agent-hub.example/auth/callback");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should rewrite every request on the viewer's host to the viewer's route, carrying the path and query asked for", async () => {
    const response = await proxy(onHost(VIEWER, "/3fa85f64-5717-4562-b3fc-2c963f66afa6/8080/docs/?token=pods-own"));

    expect(response.headers.get("x-middleware-rewrite")).toBe(`https://${VIEWER}/viewer-proxy`);
    expect(response.headers.get("x-middleware-request-x-agent-hub-viewer-url")).toBe("/3fa85f64-5717-4562-b3fc-2c963f66afa6/8080/docs/?token=pods-own");
  });

  it("should neither sign a person in nor serve a hub page on the viewer's host", async () => {
    const response = await proxy(onHost(VIEWER, "/settings/credentials"));

    expect(response.headers.get("x-middleware-rewrite")).toBe(`https://${VIEWER}/viewer-proxy`);
    expect(response.headers.get("location")).toBeNull();
  });

  it("should answer 404 on the viewer's host when the rest of the viewer's settings are missing", async () => {
    vi.stubEnv("ENTRA_REDIRECT_URI", "");

    const response = await proxy(onHost(VIEWER, "/settings/credentials"));

    expect(response.status).toBe(404);
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it.each(["/viewer-proxy", "/viewer-proxy/anything"])("should answer 404 for %s on the hub's host, so the route is only ever the viewer's", async (path) => {
    expect((await proxy(onHost("agent-hub.example", path))).status).toBe(404);
  });

  it("should answer 404 for the viewer's route when the viewer is off", async () => {
    vi.stubEnv("AGENT_HUB_VIEWER_HOST", "");

    expect((await proxy(onHost("agent-hub.example", "/viewer-proxy"))).status).toBe(404);
  });

  it("should drop a trailing slash on the hub's host, as Next did before the viewer needed it kept", async () => {
    const response = await proxy(onHost("agent-hub.example", "/agents/va-1/?tab=x"));

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://agent-hub.example/agents/va-1?tab=x");
    expect((await proxy(onHost("agent-hub.example", "https://agent-hub.example//"))).headers.get("location")).toBe("https://agent-hub.example/");
  });

  it("should strip a secret before dropping the trailing slash, so the 308 never carries it in Location", async () => {
    const response = await proxy(onHost("agent-hub.example", "/hub/agents/va-1/?token=a-pasted-token"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://agent-hub.example/hub/agents/va-1/");
  });

  // A typo naming the hub itself as the viewer switches the viewer off; it must not take the hub down with it.
  it("should serve the hub as usual when the viewer is named as the hub's own host", async () => {
    vi.stubEnv("AGENT_HUB_VIEWER_HOST", "agent-hub.example");

    expect((await proxy(onHost("agent-hub.example", "/health"))).status).toBe(200);
    expect((await proxy(onHost("agent-hub.example", "/hub"))).status).toBe(307);
  });
});
