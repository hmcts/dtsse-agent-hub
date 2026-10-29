import { isUuid } from "../agents/store.ts";
import { safeReturnTo } from "../auth/guard.ts";
import { MAX_EXPOSED_PORT, MIN_EXPOSED_PORT } from "../virtual-agents/ports.ts";

/**
 * Where things live on the viewer's host. Each port is under its own `/<virtual agent id>/<port>/` prefix, with its
 * own cookie scoped to that path, and `/_auth` is outside every prefix so no server's own paths can shadow it.
 */

export const AUTH_PATH = "/_auth";

export const TICKET_PARAMETER = "ticket";

export type ViewerPath =
  | { kind: "auth"; ticket: string | null }
  | { kind: "port"; virtualAgentId: string; port: number; rest: string; search: string }
  | { kind: "bare-port"; virtualAgentId: string; port: number; search: string }
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
 * slash after it, which the port's cookie, scoped to `/<id>/<port>/`, is never sent to.
 */
export function parseViewerPath(pathAndQuery: string): ViewerPath {
  const queryAt = pathAndQuery.indexOf("?");
  const path = queryAt === -1 ? pathAndQuery : pathAndQuery.slice(0, queryAt);
  const search = queryAt === -1 ? "" : pathAndQuery.slice(queryAt);

  if (path === AUTH_PATH) {
    return { kind: "auth", ticket: new URLSearchParams(search).get(TICKET_PARAMETER) };
  }
  const match = /^\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
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

export const VIEWER_COOKIE_PREFIX = "ahv-";

export function viewerCookieName(virtualAgentId: string, port: number): string {
  return `${VIEWER_COOKIE_PREFIX}${virtualAgentId}-${port}`;
}

/** The hub's page that checks the person and hands back a ticket for a port, landing on `path` under its prefix. */
export function ticketPath(virtualAgentId: string, port: number, path: string): string {
  return `/hub/virtual/${encodeURIComponent(virtualAgentId)}/ports/${port}?${new URLSearchParams({ path })}`;
}

/**
 * Where under a port's prefix a person may be sent: a path from `/`, by the same rule as a return path after
 * signing in, so a ticket can never carry a person off the viewer's host.
 */
export function landingPath(value: string | null | undefined): string {
  return safeReturnTo(value);
}

/**
 * The port whose page asked for `pathAndQuery` from outside every prefix, read from the request's `Referer`, and
 * where under that port's prefix the request belongs. A server that thinks it is at `/` writes links, assets and
 * form actions from `/`, which the browser sends to the viewer's root. Only a page on the viewer's own host, under a
 * port's prefix, counts, and only a path from `/` that is not the viewer's own `AUTH_PATH`.
 */
export function refererTarget(referer: string | null, viewerHost: string, pathAndQuery: string): string | undefined {
  if (referer === null || !URL.canParse(referer) || !pathAndQuery.startsWith("/") || pathAndQuery.startsWith("//")) {
    return undefined;
  }
  const from = new URL(referer);
  if (from.protocol !== "https:" || from.host !== viewerHost) {
    return undefined;
  }
  const page = parseViewerPath(from.pathname);
  if (page.kind !== "port" && page.kind !== "bare-port") {
    return undefined;
  }
  const queryAt = pathAndQuery.indexOf("?");
  if ((queryAt === -1 ? pathAndQuery : pathAndQuery.slice(0, queryAt)) === AUTH_PATH) {
    return undefined;
  }
  return `${viewerPrefix(page.virtualAgentId, page.port)}${pathAndQuery}`;
}
