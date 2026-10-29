import { type Environment, sessionSecret } from "../auth/settings.ts";

/**
 * What the viewer needs, read per call from the environment because the chart's secrets reach `process.env` only once
 * `instrumentation.ts` has loaded them.
 */
export interface ViewerSettings {
  /** The viewer's own host, lower case, as `agent-hub-viewer.aat.platform.hmcts.net`. */
  host: string;
  /** Where the viewer sends a person to be signed in and given a ticket: the hub's public origin. */
  hubOrigin: string;
  /** Tickets and viewer cookies are sealed under keys derived from the session secret. */
  secret: string;
}

/** The rewritten path every viewer request is answered from. The proxy refuses it on any other host. */
export const VIEWER_ROUTE = "/viewer-proxy";

/** The path and query the browser asked the viewer for, which the rewrite to `VIEWER_ROUTE` would otherwise lose. */
export const VIEWER_URL_HEADER = "x-agent-hub-viewer-url";

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** `AGENT_HUB_VIEWER_HOST`, or `undefined` when it is unset or is not a bare DNS name. */
export function viewerHost(env: Environment = process.env): string | undefined {
  const host = env.AGENT_HUB_VIEWER_HOST?.trim().toLowerCase();
  return host && HOST.test(host) ? host : undefined;
}

/** The origin of `ENTRA_REDIRECT_URI`, which is the hub's public address whichever host a request came in on. */
function hubOrigin(env: Environment): string | undefined {
  const raw = env.ENTRA_REDIRECT_URI?.trim();
  if (!raw || !URL.canParse(raw)) {
    return undefined;
  }
  const url = new URL(raw);
  return url.protocol === "https:" || url.protocol === "http:" ? url.origin : undefined;
}

/**
 * The host whose requests are the viewer's rather than the hub's, which is `AGENT_HUB_VIEWER_HOST` unless that is the
 * hub's own: agents' pages do not belong on the hub's origin, and routing the hub's host to the viewer would answer
 * 404 to the whole hub, probes included. `undefined` leaves the host to the hub, which a misconfigured name should
 * cost nothing more than the viewer.
 */
export function viewerRouteHost(env: Environment = process.env): string | undefined {
  const host = viewerHost(env);
  const origin = hubOrigin(env);
  if (host === undefined || (origin !== undefined && new URL(origin).hostname === host)) {
    return undefined;
  }
  return host;
}

/**
 * The viewer's settings, or `undefined` when it is off: no viewer host of its own, or nothing to seal a ticket with
 * or send a person back to.
 */
export function viewerSettings(env: Environment = process.env): ViewerSettings | undefined {
  const host = viewerRouteHost(env);
  const origin = hubOrigin(env);
  const secret = sessionSecret(env);
  if (host === undefined || origin === undefined || secret === undefined) {
    return undefined;
  }
  return { host, hubOrigin: origin, secret };
}

/** The host a request was made to, lower case and without a port, from `Host` as Traefik routed it. */
export function requestHost(headers: Headers, fallback: string): string {
  const host = (headers.get("host") ?? fallback).toLowerCase();
  return host.replace(/:\d+$/, "");
}
