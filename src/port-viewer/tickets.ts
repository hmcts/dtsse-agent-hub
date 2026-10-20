import { open, seal } from "../auth/sealed.ts";

/**
 * The hand-off from the hub to the viewer, and what the viewer then keeps. Both are sealed with the session secret
 * under a key of their own, and carry their purpose too, so neither opens as the other or as an `ah_session`.
 *
 * A ticket travels in a URL, through the browser's history and the front door's logs, which is why it lasts only
 * long enough to follow one redirect.
 */

export const TICKET_MAX_AGE = 60;

/** The working day a session lasts. Every request still reads the agent again, so this bounds nothing else. */
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

type Purpose = "viewer-ticket" | "viewer-cookie";

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
