import { isUuid } from "../agents/ids.ts";
import { safeReturnTo } from "../auth/guard.ts";
import { isFeedbackToken } from "../feedback/tokens.ts";
import { MAX_EXPOSED_PORT, MIN_EXPOSED_PORT } from "../virtual-agents/ports.ts";

/**
 * The hub's ticket route, `/assistant/ports/{virtual agent id}/{port}`: the id then the port, as in the port's own
 * prefix on the viewer's host. Under the Assistant, whose settings are where a person opens their web servers.
 */
export const PORT_TICKETS = "/assistant/ports";

/** The hub's page a feedback link opens on, `/review/{token}`, which frames the prototype from the viewer's host. */
export const REVIEW_PAGES = "/review";

/**
 * Where things live on the viewer's host. Each port is under its own `/<virtual agent id>/<port>/` prefix, and each
 * feedback link under `/f/<token>/`, with its own cookie scoped to that path. `/_auth` and the feedback widget are
 * outside every prefix so no server's own paths can shadow them.
 */

export const AUTH_PATH = "/_auth";

/** The script injected into every page a feedback link serves: on the viewer's host, so the page's own origin. */
export const WIDGET_PATH = "/_feedback/widget.js";

export const TICKET_PARAMETER = "ticket";

/** The first segment of every feedback link's prefix, which no virtual agent id can be. */
const FEEDBACK_SEGMENT = "f";

export type ViewerPath =
  | { kind: "auth"; ticket: string | null }
  | { kind: "widget" }
  | { kind: "port"; virtualAgentId: string; port: number; rest: string; search: string }
  | { kind: "bare-port"; virtualAgentId: string; port: number; search: string }
  | { kind: "feedback"; token: string; rest: string; search: string }
  | { kind: "bare-feedback"; token: string; search: string }
  | { kind: "none" };

/** A port as written in a path: canonical decimal only, so `08080` is not a second spelling of a prefix. */
export function portOf(value: string): number | undefined {
  if (!/^[1-9]\d{0,4}$/.test(value)) {
    return undefined;
  }
  const port = Number(value);
  return port >= MIN_EXPOSED_PORT && port <= MAX_EXPOSED_PORT ? port : undefined;
}

/**
 * What a viewer request asks for, from the path and query the browser sent. `bare-port` is `/<id>/<port>` with no
 * slash after it, which the port's cookie, scoped to `/<id>/<port>/`, is never sent to; `bare-feedback` is the same
 * for `/f/<token>`.
 */
export function parseViewerPath(pathAndQuery: string): ViewerPath {
  const queryAt = pathAndQuery.indexOf("?");
  const path = queryAt === -1 ? pathAndQuery : pathAndQuery.slice(0, queryAt);
  const search = queryAt === -1 ? "" : pathAndQuery.slice(queryAt);

  if (path === AUTH_PATH) {
    return { kind: "auth", ticket: new URLSearchParams(search).get(TICKET_PARAMETER) };
  }
  if (path === WIDGET_PATH) {
    return { kind: "widget" };
  }
  const match = /^\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  if (match?.[1] === FEEDBACK_SEGMENT) {
    const token = match[2]!;
    const rest = match[3];
    if (!isFeedbackToken(token)) {
      return { kind: "none" };
    }
    return rest === undefined ? { kind: "bare-feedback", token, search } : { kind: "feedback", token, rest, search };
  }
  const port = match === null ? undefined : portOf(match[2]!);
  const virtualAgentId = match?.[1];
  // Lower case only: a cookie's path matches case-sensitively, so an upper-case id would never be sent the cookie
  // scoped to the canonical prefix, and would bounce through the hub for ever.
  if (match === null || port === undefined || virtualAgentId === undefined || !isUuid(virtualAgentId) || virtualAgentId !== virtualAgentId.toLowerCase()) {
    return { kind: "none" };
  }
  const rest = match[3];
  return rest === undefined ? { kind: "bare-port", virtualAgentId, port, search } : { kind: "port", virtualAgentId, port, rest, search };
}

export function viewerPrefix(virtualAgentId: string, port: number): string {
  return `/${virtualAgentId}/${port}`;
}

export function viewerUrl(host: string, virtualAgentId: string, port: number): string {
  return `https://${host}${viewerPrefix(virtualAgentId, port)}/`;
}

export function feedbackPrefix(token: string): string {
  return `/${FEEDBACK_SEGMENT}/${token}`;
}

/**
 * Whether a path on the viewer's host is under a feedback link's prefix, or is its bare prefix: the only responses
 * the hub's own pages may frame.
 */
export function isFeedbackPath(pathname: string): boolean {
  return pathname === `/${FEEDBACK_SEGMENT}` || pathname.startsWith(`/${FEEDBACK_SEGMENT}/`);
}

export const VIEWER_COOKIE_PREFIX = "ahv-";

export function viewerCookieName(virtualAgentId: string, port: number): string {
  return `${VIEWER_COOKIE_PREFIX}${virtualAgentId}-${port}`;
}

/** A feedback link's cookie, scoped to its prefix as a port's is. */
export function feedbackCookieName(token: string): string {
  return `${VIEWER_COOKIE_PREFIX}${FEEDBACK_SEGMENT}-${token}`;
}

/** The hub's route that checks the person and hands back a ticket for a port, landing on `path` under its prefix. */
export function ticketPath(virtualAgentId: string, port: number, path: string): string {
  return `${PORT_TICKETS}/${encodeURIComponent(virtualAgentId)}/${port}?${new URLSearchParams({ path })}`;
}

/**
 * The hub's review page for a feedback link, which signs the person in, checks the link and frames it again with a
 * fresh ticket, landing on `path` under the link's prefix.
 */
export function reviewPath(token: string, path: string): string {
  return `${REVIEW_PAGES}/${encodeURIComponent(token)}?${new URLSearchParams({ path })}`;
}

/**
 * Where under a prefix a person may be sent: a path from `/`, by the same rule as a return path after signing in,
 * so a ticket can never carry a person off the viewer's host.
 */
export function landingPath(value: string | null | undefined): string {
  return safeReturnTo(value);
}

/**
 * The port or feedback link whose page asked for `pathAndQuery` from outside every prefix, read from the request's
 * `Referer`, and where under that page's prefix the request belongs. A server that thinks it is at `/` writes links,
 * assets and form actions from `/`, which the browser sends to the viewer's root. Only a page on the viewer's own
 * host, under a prefix, counts, and only a path from `/` that is not one of the viewer's own, `AUTH_PATH` and
 * `WIDGET_PATH`.
 */
export function refererTarget(referer: string | null, viewerHost: string, pathAndQuery: string): string | undefined {
  if (referer === null || !URL.canParse(referer)) {
    return undefined;
  }
  const from = new URL(referer);
  if (from.protocol !== "https:" || from.host !== viewerHost) {
    return undefined;
  }
  return underPage(parseViewerPath(from.pathname), pathAndQuery);
}

/**
 * The cookie naming the prefix whose page the browser was last sent, on the viewer's whole host: `<id>/<port>` for a
 * port and `f/<token>` for a feedback link. A single-page app that changes its own URL with `history.pushState`
 * leaves its prefix, so its later requests carry a `Referer` from `/` that names no prefix. Only where to send a
 * request, never whether it may be served: that is still the prefix's own cookie's to say. Named under
 * `VIEWER_COOKIE_PREFIX`, so it is never forwarded upstream and no upstream can set it.
 */
export const LAST_PORT_COOKIE = `${VIEWER_COOKIE_PREFIX}last`;

function lastPageCookie(prefix: string, maxAge: number): string {
  return `${LAST_PORT_COOKIE}=${prefix.slice(1)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export function lastPortCookie(virtualAgentId: string, port: number, maxAge: number): string {
  return lastPageCookie(viewerPrefix(virtualAgentId, port), maxAge);
}

export function lastFeedbackCookie(token: string, maxAge: number): string {
  return lastPageCookie(feedbackPrefix(token), maxAge);
}

/** Where `pathAndQuery` belongs under the prefix `LAST_PORT_COOKIE` names, by the same rules as `refererTarget`. */
export function lastPortTarget(value: string | undefined, pathAndQuery: string): string | undefined {
  return value === undefined ? undefined : underPage(parseViewerPath(`/${value}/`), pathAndQuery);
}

/** The prefix of a port's or a feedback link's page, and nothing for any other path. */
function pagePrefix(page: ViewerPath): string | undefined {
  switch (page.kind) {
    case "port":
    case "bare-port":
      return viewerPrefix(page.virtualAgentId, page.port);
    case "feedback":
    case "bare-feedback":
      return feedbackPrefix(page.token);
    default:
      return undefined;
  }
}

/** `pathAndQuery` under the prefix of `page`, when it has one and the path is from `/` and not the viewer's own. */
function underPage(page: ViewerPath, pathAndQuery: string): string | undefined {
  const prefix = pagePrefix(page);
  if (prefix === undefined || !pathAndQuery.startsWith("/") || pathAndQuery.startsWith("//")) {
    return undefined;
  }
  const queryAt = pathAndQuery.indexOf("?");
  const path = queryAt === -1 ? pathAndQuery : pathAndQuery.slice(0, queryAt);
  if (path === AUTH_PATH || path === WIDGET_PATH) {
    return undefined;
  }
  return `${prefix}${pathAndQuery}`;
}
