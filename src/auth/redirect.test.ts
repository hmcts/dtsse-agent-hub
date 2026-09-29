import { describe, expect, it } from "vitest";
import { redirectAway, redirectTo } from "./redirect.ts";

describe("redirectTo", () => {
  it.each(["/", "/agents/0f8a", "/auth/login", "/c?topics=pcs-api"])("should emit %s as a RELATIVE location", (path) => {
    const location = redirectTo(path).headers.get("location");

    expect(location).toBe(path);
    expect(location).not.toMatch(/^https?:\/\//);
  });

  it("should redirect temporarily, so nothing caches the bounce", () => {
    expect(redirectTo("/").status).toBe(307);
  });

  it("should carry no body", async () => {
    expect(await redirectTo("/").text()).toBe("");
  });
});

describe("redirectAway", () => {
  it("should keep an absolute location, which is the only correct form for somewhere off this service", () => {
    const url = new URL("https://login.microsoftonline.com/a-tenant/oauth2/v2.0/authorize?client_id=x");

    expect(redirectAway(url).headers.get("location")).toBe(url.toString());
  });
});
