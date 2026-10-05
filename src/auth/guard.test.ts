import { describe, expect, it } from "vitest";
import { exempt, safeReturnTo } from "./guard.ts";

describe("exempt", () => {
  it.each([
    "/health",
    "/health/liveness",
    "/health/readiness",
    "/liveness",
    "/readiness"
  ])("should serve %s without a session, because a probe cannot sign in", (path) => {
    expect(exempt(path)).toBe(true);
  });

  it("should serve the sign-in routes without a session, or nobody could ever get one", () => {
    expect(exempt("/auth/login")).toBe(true);
    expect(exempt("/auth/callback")).toBe(true);
    expect(exempt("/auth/logout")).toBe(true);
  });

  it("should serve the compiled bundles and stylesheet without a session", () => {
    expect(exempt("/_next/static/chunks/main.js")).toBe(true);
    expect(exempt("/favicon.ico")).toBe(true);
  });

  it("should leave the agent API to its own bearer authentication", () => {
    expect(exempt("/api/agent/register")).toBe(true);
    expect(exempt("/api/agent/0f8a/stream")).toBe(true);
  });

  it("should leave the virtual-agent and orchestrator APIs to their own bearer authentication", () => {
    expect(exempt("/api/virtual/0f8a/status")).toBe(true);
    expect(exempt("/api/orchestrator/claim")).toBe(true);
    expect(exempt("/api/virtualx")).toBe(false);
  });

  it.each([
    "/api/ui/stream",
    "/api/ui/feed",
    "/api/ui/topics",
    "/api/ui/session"
  ])("should leave %s to answer 401 itself, because fetch and EventSource cannot act on a redirect to sign in", (path) => {
    expect(exempt(path)).toBe(true);
  });

  it.each(["/", "/c", "/agents/0f8a", "/access"])("should require a session for %s", (path) => {
    expect(exempt(path)).toBe(false);
  });

  it.each([
    "/healthcheck-report",
    "/health-summary",
    "/authors",
    "/_nextdoor",
    "/authentication",
    "/api/agents",
    "/api/ui",
    "/api/uix/stream"
  ])("should not exempt %s, which merely begins the same way as an exempt path", (path) => {
    expect(exempt(path)).toBe(false);
  });
});

describe("safeReturnTo", () => {
  it.each(["/", "/c?topics=pcs-api,database&mode=any", "/agents/0f8a", "/access#grants"])("should keep the same-origin path %s", (path) => {
    expect(safeReturnTo(path)).toBe(path);
  });

  it("should keep a path containing a hyphen, which a careless character class would reject", () => {
    expect(safeReturnTo("/c?topics=pcs-api")).toBe("/c?topics=pcs-api");
  });

  it.each([
    ["an absolute url", "https://elsewhere.example/steal"],
    ["a protocol-relative url", "//elsewhere.example/steal"],
    ["a scheme without a host", "javascript:alert(1)"],
    ["a bare path with no leading slash", "repositories"],
    ["nothing at all", ""],
    ["null", null],
    ["undefined", undefined]
  ])("should refuse %s and fall back to the home page", (_label, value) => {
    expect(safeReturnTo(value)).toBe("/");
  });

  it("should refuse a backslash, which some browsers normalise into a protocol-relative url", () => {
    expect(safeReturnTo("/\\elsewhere.example")).toBe("/");
  });

  it.each([
    ["a newline, which would split the Location header", 0x0a],
    ["a carriage return", 0x0d],
    ["a NUL", 0x00],
    ["a DEL", 0x7f]
  ])("should refuse %s", (_label, code) => {
    expect(safeReturnTo(`/c${String.fromCharCode(code)}x`)).toBe("/");
  });
});
