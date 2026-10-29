import { afterEach, describe, expect, it, vi } from "vitest";
import { seal } from "../auth/sealed.ts";
import { readSession, sealSession } from "../auth/session.ts";
import { openTicket, openViewerCookie, sealTicket, sealViewerCookie, TICKET_MAX_AGE, VIEWER_COOKIE_MAX_AGE } from "./tickets.ts";

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
