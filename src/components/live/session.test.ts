import { describe, expect, it, vi } from "vitest";
import { SESSION_URL, sessionEnded, signInAgainHref } from "./session.ts";

describe("sessionEnded", () => {
  it("should say the session has ended when the session check answers 401", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 401 }));

    expect(await sessionEnded(fetcher)).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(SESSION_URL, { cache: "no-store" });
  });

  it.each([204, 500, 502])("should not say the session has ended when the session check answers %i", async (status) => {
    expect(await sessionEnded(async () => new Response(null, { status }))).toBe(false);
  });

  it("should not say the session has ended when the session check cannot be made", async () => {
    expect(
      await sessionEnded(async () => {
        throw new TypeError("Failed to fetch");
      })
    ).toBe(false);
  });
});

describe("signInAgainHref", () => {
  it("should send the person to sign in and back to the page they were on when the session has ended", () => {
    const href = new URL(signInAgainHref("/c?topics=pcs-api,database&mode=any"), "https://agent-hub.example");

    expect(href.pathname).toBe("/auth/login");
    expect(href.searchParams.get("redirect")).toBe("/c?topics=pcs-api,database&mode=any");
  });
});
