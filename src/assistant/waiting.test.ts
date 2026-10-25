import { describe, expect, it } from "vitest";
import { WAITING_COOKIE, waitingCookie, waitingDismissed } from "./waiting.ts";

const ASSISTANT = "0f8a6a1e-0000-4000-8000-000000000001";

describe("waitingDismissed", () => {
  it("should be true when the cookie names this assistant", () => {
    expect(waitingDismissed(ASSISTANT, ASSISTANT)).toBe(true);
  });

  it("should be false when there is no cookie", () => {
    expect(waitingDismissed(undefined, ASSISTANT)).toBe(false);
    expect(waitingDismissed("", ASSISTANT)).toBe(false);
  });

  it("should be false when the cookie names another assistant, so a new one asks again", () => {
    expect(waitingDismissed("0f8a6a1e-0000-4000-8000-000000000002", ASSISTANT)).toBe(false);
  });
});

describe("waitingCookie", () => {
  it("should last the browser session when it remembers the choice", () => {
    const cookie = waitingCookie(ASSISTANT);

    expect(cookie).toBe(`${WAITING_COOKIE}=${ASSISTANT}; Path=/; SameSite=Lax`);
    expect(cookie).not.toContain("Max-Age");
  });

  it("should expire at once when it clears the choice", () => {
    expect(waitingCookie(null)).toBe(`${WAITING_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`);
  });
});
