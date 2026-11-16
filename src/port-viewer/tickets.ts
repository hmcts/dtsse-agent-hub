import { open, seal } from "../auth/sealed.ts";

/**
 * The hand-off from the hub to the viewer, and what the viewer then keeps, for a port or a feedback link. Each is
 * sealed with the session secret under a key of its own, and carries its purpose too, so none opens as another or as
 * an `ah_session`.
 *
 * A ticket travels in a URL, through the browser's history and the front door's logs, which is why it lasts only
 * long enough to follow one redirect.
 */

export const TICKET_MAX_AGE = 60;

/** The working day a session lasts. Every request still reads the agent or link again, so this bounds nothing else. */
export const VIEWER_COOKIE_MAX_AGE = 8 * 60 * 60;

export interface PortGrant {
  oid: string;
  virtualAgentId: string;
  port: number;
}

export interface Ticket extends PortGrant {
  /** Where to land under the port's prefix. */
  path: string;
}

/** A person's hold on one feedback link, re-checked against the link on every request. */
export interface FeedbackGrant {
  oid: string;
  /** The link's token, which is also its prefix on the viewer's host. */
  token: string;
}

export interface FeedbackTicket extends FeedbackGrant {
  /** Where to land under the link's prefix. */
  path: string;
}

/** Long enough to sign in, short enough that a sign-in service the prototype once named is not served for the day. */
export const SIGN_IN_GRANT_MAX_AGE = 60 * 60;

/** A sign-in service a feedback link's prototype sent the browser to, which the viewer then serves under the link. */
export interface SignInGrant {
  token: string;
  origin: string;
}

type Purpose = "viewer-ticket" | "viewer-cookie" | "feedback-ticket" | "feedback-cookie" | "sign-in-grant";

function keyFor(secret: string, purpose: Purpose): string {
  return `${secret}\u0000agent-hub:${purpose}`;
}

function grantOf(payload: Record<string, unknown> | undefined, purpose: Purpose): PortGrant | undefined {
  if (payload === undefined || payload.purpose !== purpose) {
    return undefined;
  }
  const { oid, virtualAgentId, port } = payload;
  if (typeof oid !== "string" || typeof virtualAgentId !== "string" || typeof port !== "number" || !Number.isInteger(port)) {
    return undefined;
  }
  return { oid, virtualAgentId, port };
}

export async function sealTicket(ticket: Ticket, secret: string, now = new Date()): Promise<string> {
  return await seal({ ...ticket, purpose: "viewer-ticket" }, keyFor(secret, "viewer-ticket"), TICKET_MAX_AGE, now);
}

export async function openTicket(token: string | null | undefined, secret: string): Promise<Ticket | undefined> {
  const payload = await open(token ?? undefined, keyFor(secret, "viewer-ticket"));
  const grant = grantOf(payload, "viewer-ticket");
  if (grant === undefined || typeof payload?.path !== "string") {
    return undefined;
  }
  return { ...grant, path: payload.path };
}

export async function sealViewerCookie(grant: PortGrant, secret: string, now = new Date()): Promise<string> {
  const { oid, virtualAgentId, port } = grant;
  return await seal({ oid, virtualAgentId, port, purpose: "viewer-cookie" }, keyFor(secret, "viewer-cookie"), VIEWER_COOKIE_MAX_AGE, now);
}

export async function openViewerCookie(token: string | undefined, secret: string): Promise<PortGrant | undefined> {
  return grantOf(await open(token, keyFor(secret, "viewer-cookie")), "viewer-cookie");
}

function feedbackGrantOf(payload: Record<string, unknown> | undefined, purpose: Purpose): FeedbackGrant | undefined {
  if (payload === undefined || payload.purpose !== purpose) {
    return undefined;
  }
  const { oid, token } = payload;
  return typeof oid === "string" && typeof token === "string" ? { oid, token } : undefined;
}

export async function sealFeedbackTicket(ticket: FeedbackTicket, secret: string, now = new Date()): Promise<string> {
  const { oid, token, path } = ticket;
  return await seal({ oid, token, path, purpose: "feedback-ticket" }, keyFor(secret, "feedback-ticket"), TICKET_MAX_AGE, now);
}

export async function openFeedbackTicket(token: string | null | undefined, secret: string): Promise<FeedbackTicket | undefined> {
  const payload = await open(token ?? undefined, keyFor(secret, "feedback-ticket"));
  const grant = feedbackGrantOf(payload, "feedback-ticket");
  if (grant === undefined || typeof payload?.path !== "string") {
    return undefined;
  }
  return { ...grant, path: payload.path };
}

export async function sealFeedbackCookie(grant: FeedbackGrant, secret: string, now = new Date()): Promise<string> {
  const { oid, token } = grant;
  return await seal({ oid, token, purpose: "feedback-cookie" }, keyFor(secret, "feedback-cookie"), VIEWER_COOKIE_MAX_AGE, now);
}

export async function openFeedbackCookie(token: string | undefined, secret: string): Promise<FeedbackGrant | undefined> {
  return feedbackGrantOf(await open(token, keyFor(secret, "feedback-cookie")), "feedback-cookie");
}

export async function sealSignInGrant(grant: SignInGrant, secret: string, now = new Date()): Promise<string> {
  const { token, origin } = grant;
  return await seal({ token, origin, purpose: "sign-in-grant" }, keyFor(secret, "sign-in-grant"), SIGN_IN_GRANT_MAX_AGE, now);
}

export async function openSignInGrant(value: string | undefined, secret: string): Promise<SignInGrant | undefined> {
  const payload = await open(value, keyFor(secret, "sign-in-grant"));
  if (payload?.purpose !== "sign-in-grant" || typeof payload.token !== "string" || typeof payload.origin !== "string") {
    return undefined;
  }
  return { token: payload.token, origin: payload.origin };
}
