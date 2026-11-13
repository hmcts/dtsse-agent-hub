import { afterEach, describe, expect, it, vi } from "vitest";
import { seal } from "../auth/sealed.ts";
import { readSession, sealSession } from "../auth/session.ts";
import {
  openFeedbackCookie,
  openFeedbackTicket,
  openSignInGrant,
  openTicket,
  openViewerCookie,
  SIGN_IN_GRANT_MAX_AGE,
  sealFeedbackCookie,
  sealFeedbackTicket,
  sealSignInGrant,
  sealTicket,
  sealViewerCookie,
  TICKET_MAX_AGE,
  VIEWER_COOKIE_MAX_AGE
} from "./tickets.ts";

const SECRET = "a-test-session-secret-long-enough-to-be-plausible";
const GRANT = { oid: "owner-oid", virtualAgentId: "3fa85f64-5717-4562-b3fc-2c963f66afa6", port: 8080 };
const TICKET = { ...GRANT, path: "/docs" };

afterEach(() => {
  vi.useRealTimers();
});

describe("tickets", () => {
  it("should carry the person, agent, port and path back out when opened with the same secret", async () => {
    expect(await openTicket(await sealTicket(TICKET, SECRET), SECRET)).toEqual(TICKET);
  });

  it("should not open when it is missing, altered or sealed under another secret", async () => {
    const token = await sealTicket(TICKET, SECRET);

    expect(await openTicket(null, SECRET)).toBeUndefined();
    expect(await openTicket(`${token}x`, SECRET)).toBeUndefined();
    expect(await openTicket(token, "a-different-secret-entirely")).toBeUndefined();
  });

  it("should not open once a minute has passed since it was sealed", async () => {
    vi.useFakeTimers();
    const token = await sealTicket(TICKET, SECRET);

    vi.advanceTimersByTime((TICKET_MAX_AGE + 1) * 1000);

    expect(await openTicket(token, SECRET)).toBeUndefined();
  });

  it("should not open as a viewer cookie or a session when either is presented with it", async () => {
    const token = await sealTicket(TICKET, SECRET);

    expect(await openViewerCookie(token, SECRET)).toBeUndefined();
    expect(await readSession(token, SECRET)).toBeUndefined();
  });

  it("should not open when its claims are not the shape a ticket has", async () => {
    // Sealed directly under the ticket's key, so only the shape check stands between it and being accepted.
    const key = `${SECRET}\u0000agent-hub:viewer-ticket`;

    expect(await openTicket(await seal({ ...TICKET, purpose: "viewer-ticket", path: 1 }, key, 60), SECRET)).toBeUndefined();
    expect(await openTicket(await seal({ ...TICKET, purpose: "viewer-ticket", port: "8080" }, key, 60), SECRET)).toBeUndefined();
    expect(await openTicket(await seal({ ...TICKET, purpose: "viewer-cookie" }, key, 60), SECRET)).toBeUndefined();
  });
});

describe("viewer cookies", () => {
  it("should carry the person, agent and port back out, and nothing of the ticket's path", async () => {
    expect(await openViewerCookie(await sealViewerCookie(TICKET, SECRET), SECRET)).toEqual(GRANT);
  });

  it("should not open once the working day it lasts is over", async () => {
    vi.useFakeTimers();
    const token = await sealViewerCookie(GRANT, SECRET);

    vi.advanceTimersByTime((VIEWER_COOKIE_MAX_AGE + 1) * 1000);

    expect(await openViewerCookie(token, SECRET)).toBeUndefined();
  });

  it("should not open as a ticket, and a session should not open as one, when either is presented as the other", async () => {
    const session = await sealSession({ oid: "owner-oid", tid: "tenant", name: "An Owner", aiGateway: false }, SECRET);

    expect(await openTicket(await sealViewerCookie(GRANT, SECRET), SECRET)).toBeUndefined();
    expect(await openViewerCookie(session, SECRET)).toBeUndefined();
  });
});

describe("feedback tickets and cookies", () => {
  const LINK = { oid: "reviewer-oid", token: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde" };

  it("should carry the person, link and path back out of a ticket, and only the person and link out of a cookie", async () => {
    expect(await openFeedbackTicket(await sealFeedbackTicket({ ...LINK, path: "/start" }, SECRET), SECRET)).toEqual({ ...LINK, path: "/start" });
    expect(await openFeedbackCookie(await sealFeedbackCookie({ ...LINK, path: "/start" } as typeof LINK, SECRET), SECRET)).toEqual(LINK);
  });

  it("should not open a feedback ticket once a minute has passed since it was sealed", async () => {
    vi.useFakeTimers();
    const token = await sealFeedbackTicket({ ...LINK, path: "/" }, SECRET);

    vi.advanceTimersByTime((TICKET_MAX_AGE + 1) * 1000);

    expect(await openFeedbackTicket(token, SECRET)).toBeUndefined();
  });

  it("should not open as a port's ticket or cookie, nor either of those as a feedback one, when presented as the other", async () => {
    const feedbackTicket = await sealFeedbackTicket({ ...LINK, path: "/" }, SECRET);
    const feedbackCookie = await sealFeedbackCookie(LINK, SECRET);

    expect(await openTicket(feedbackTicket, SECRET)).toBeUndefined();
    expect(await openViewerCookie(feedbackCookie, SECRET)).toBeUndefined();
    expect(await openFeedbackCookie(feedbackTicket, SECRET)).toBeUndefined();
    expect(await openFeedbackTicket(feedbackCookie, SECRET)).toBeUndefined();
    expect(await openFeedbackTicket(await sealTicket(TICKET, SECRET), SECRET)).toBeUndefined();
    expect(await openFeedbackCookie(await sealViewerCookie(GRANT, SECRET), SECRET)).toBeUndefined();
    expect(await openFeedbackTicket(null, SECRET)).toBeUndefined();
  });

  it("should not open when its claims are not the shape a feedback ticket or cookie has", async () => {
    const ticketKey = `${SECRET}\u0000agent-hub:feedback-ticket`;
    const cookieKey = `${SECRET}\u0000agent-hub:feedback-cookie`;

    expect(await openFeedbackTicket(await seal({ ...LINK, purpose: "feedback-ticket", path: 1 }, ticketKey, 60), SECRET)).toBeUndefined();
    expect(await openFeedbackTicket(await seal({ ...LINK, purpose: "feedback-ticket", path: "/", token: 1 }, ticketKey, 60), SECRET)).toBeUndefined();
    expect(await openFeedbackCookie(await seal({ ...LINK, purpose: "feedback-ticket" }, cookieKey, 60), SECRET)).toBeUndefined();
  });
});

describe("sign-in grants", () => {
  const SIGN_IN = { token: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde", origin: "https://idam.example" };

  it("should carry the link and the sign-in service's origin back out", async () => {
    expect(await openSignInGrant(await sealSignInGrant(SIGN_IN, SECRET), SECRET)).toEqual(SIGN_IN);
  });

  it("should not open once an hour has passed since it was sealed", async () => {
    vi.useFakeTimers();
    const grant = await sealSignInGrant(SIGN_IN, SECRET);

    vi.advanceTimersByTime((SIGN_IN_GRANT_MAX_AGE - 1) * 1000);
    expect(await openSignInGrant(grant, SECRET)).toEqual(SIGN_IN);
    vi.advanceTimersByTime(2000);
    expect(await openSignInGrant(grant, SECRET)).toBeUndefined();
  });

  it("should not open when forged, sealed with another secret or for another purpose", async () => {
    const grantKey = `${SECRET}\u0000agent-hub:sign-in-grant`;

    expect(await openSignInGrant("not-a-grant", SECRET)).toBeUndefined();
    expect(await openSignInGrant(await sealSignInGrant(SIGN_IN, "another-secret"), SECRET)).toBeUndefined();
    expect(await openSignInGrant(await sealFeedbackCookie({ oid: "o", token: SIGN_IN.token }, SECRET), SECRET)).toBeUndefined();
    expect(await openSignInGrant(await seal({ ...SIGN_IN, purpose: "feedback-cookie" }, grantKey, 60), SECRET)).toBeUndefined();
    expect(await openSignInGrant(await seal({ ...SIGN_IN, purpose: "sign-in-grant", origin: 1 }, grantKey, 60), SECRET)).toBeUndefined();
    expect(await openFeedbackCookie(await sealSignInGrant(SIGN_IN, SECRET), SECRET)).toBeUndefined();
  });
});
