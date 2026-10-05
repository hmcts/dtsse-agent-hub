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
    const response = await proxy(ask("/c?topics=pcs-api,database&mode=any"));

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("redirect")).toBe("/c?topics=pcs-api,database&mode=any");
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
    expect(pattern.test("/c")).toBe(true);
    expect(pattern.test("/_next/static/chunks/main.js")).toBe(false);
  });
});
