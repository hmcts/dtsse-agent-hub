import { describe, expect, it } from "vitest";
import { WAITING_COOKIE, waitingCookie, waitingDismissed } from "./waiting.ts";

const ASSISTANT = "0f8a6a1e-0000-4000-8000-000000000001";
const STARTED = "2026-10-25T07:00:00.000Z";

describe("waitingDismissed", () => {
  it("should be true when the cookie names this assistant and this start", () => {
    expect(waitingDismissed(`${ASSISTANT}|${STARTED}`, ASSISTANT, STARTED)).toBe(true);
  });

  it("should be false when there is no cookie", () => {
    expect(waitingDismissed(undefined, ASSISTANT, STARTED)).toBe(false);
    expect(waitingDismissed("", ASSISTANT, STARTED)).toBe(false);
  });

  it("should be false when the cookie names another assistant, so a new one asks again", () => {
    expect(waitingDismissed(`0f8a6a1e-0000-4000-8000-000000000002|${STARTED}`, ASSISTANT, STARTED)).toBe(false);
  });

  it("should be false when the assistant has been started again, so the next wait asks again", () => {
    expect(waitingDismissed(`${ASSISTANT}|${STARTED}`, ASSISTANT, "2026-10-25T20:00:00.000Z")).toBe(false);
  });

  it("should be false when the cookie names only the assistant, as an older one of these did", () => {
    expect(waitingDismissed(ASSISTANT, ASSISTANT, STARTED)).toBe(false);
  });
});

describe("waitingCookie", () => {
  it("should last the browser session when it remembers the choice", () => {
    const cookie = waitingCookie({ id: ASSISTANT, startedAt: STARTED });

    expect(cookie).toBe(`${WAITING_COOKIE}=${ASSISTANT}|${STARTED}; Path=/; SameSite=Lax`);
    expect(cookie).not.toContain("Max-Age");
  });

  it("should write a value a browser keeps whole when it remembers the choice", () => {
    const written = waitingCookie({ id: ASSISTANT, startedAt: STARTED });

    // A cookie value may not hold a comma, a semicolon, a backslash, a quote or whitespace.
    expect(written.slice(`${WAITING_COOKIE}=`.length).split(";")[0]).not.toMatch(/[,\\"\s]/);
  });

  it("should expire at once when it clears the choice", () => {
    expect(waitingCookie(null)).toBe(`${WAITING_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`);
  });
});
