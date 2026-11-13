import { type NextRequest, NextResponse } from "next/server";
import { carriesSecret, exempt } from "@/auth/guard";
import { readSession, SESSION_COOKIE } from "@/auth/session";
import { authRequired, sessionSecret } from "@/auth/settings";
import { requestHost, VIEWER_ROUTE, VIEWER_URL_HEADER, viewerRouteHost, viewerSettings } from "@/port-viewer/settings";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { movedHubPath, movedPortTicketPath, retiredPath } from "@/web/home";

/**
 * Sends a person with no session to sign in, before anything renders. Named `proxy`: Next 16 replaced the
 * `middleware` file convention with this one.
 *
 * `authSettings()` is deliberately not called here: it throws on incomplete configuration, and throwing from the
 * proxy would take `/health` down too. The login route calls it, where the error is visible without costing probes.
 */
/**
 * A pathname that cannot name anywhere but this origin.
 *
 * `new URL("//elsewhere.example", origin)` is a scheme-relative URL, so the base is discarded and the result is
 * another site altogether: without this, a request for `//elsewhere.example/` is answered with a 308 sending the
 * person there, from above the sign-in check and so without a session. Browsers normalise a leading backslash to a
 * slash before sending, so `/\elsewhere.example/` arrives the same way and collapses here too.
 */
function ownPath(pathname: string): string {
  return `/${pathname.replace(/^[/\\]+/, "")}`;
}

/**
 * The framing headers every answer carries but the viewer route's, which sets its own: it alone knows which of its
 * answers are a feedback link's, which the hub's review page frames.
 *
 * Here rather than in next.config.mjs, because Next writes a config header onto the response before the route runs
 * and then skips any header of the same name the route returns (`sendResponse` in next/dist/server/send-response.js),
 * so a config value cannot be lifted for one route. The proxy's own response headers are written the same way, which
 * is why the viewer's rewrite carries none.
 */
const FRAMING_HEADERS = [
  ["x-frame-options", "DENY"],
  // frame-ancestors only: a default-src or script-src would block the inline scripts Next renders.
  ["content-security-policy", "frame-ancestors 'none'"]
] as const;

export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (forViewer(request) && !isHealthPath(request.nextUrl.pathname) && viewerSettings() !== undefined) {
    return toViewer(request);
  }
  const response = await hubProxy(request);
  for (const [name, value] of FRAMING_HEADERS) {
    response.headers.set(name, value);
  }
  return response;
}

/** Whether the request is to the viewer's host, which serves agents' and prototypes' pages and never the hub's own. */
function forViewer(request: NextRequest): boolean {
  const host = viewerRouteHost();
  return host !== undefined && requestHost(request.headers, request.nextUrl.host) === host;
}

async function hubProxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  // Ahead of everything else: what `proxy` has not sent to the viewer's route on its host is still never the hub's
  // own, even when the rest of the viewer's settings are missing.
  if (forViewer(request)) {
    // Except the health routes, which the Application Gateway in front probes on every host it serves, at
    // `/health/liveness`: answered by the viewer they are a 404, and the gateway marks the backend unhealthy and
    // gives 502 for the whole host. An agent's pages are only ever under `/<id>/<port>/`, so none is shadowed.
    if (isHealthPath(pathname)) {
      return NextResponse.next();
    }
    return new NextResponse(null, { status: 404 });
  }
  if (pathname === VIEWER_ROUTE || pathname.startsWith(`${VIEWER_ROUTE}/`)) {
    return new NextResponse(null, { status: 404 });
  }
  // Ahead of the sign-in check, which would otherwise copy the query into the login's `redirect=`.
  if (carriesSecret(request.method, request.nextUrl.pathname, request.nextUrl.searchParams)) {
    return NextResponse.redirect(new URL(ownPath(request.nextUrl.pathname), request.nextUrl.origin), 303);
  }
  // The redirect Next makes itself without `skipTrailingSlashRedirect`, which the viewer needs off: a pod's `/docs/` is
  // not its `/docs`. Below `carriesSecret`, so a pasted secret is already stripped by the time this copies the query.
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return NextResponse.redirect(new URL(`${ownPath(pathname).replace(/\/+$/, "") || "/"}${search}`, request.nextUrl.origin), 308);
  }
  // The hub's bare addresses are sent to `/hub` from here, and retired addresses to what replaced them, and never
  // from `redirects()` in next.config.mjs, which Next checks ahead of the proxy: a 308 from there repeats the query
  // into its own `Location`, and Traefik's access log keeps it. Below `carriesSecret`, so a pasted secret is already
  // stripped by the time either builds a URL. Retired first, since a bare retired address is both.
  // A retired page's query is dropped: what replaced it takes its own, and its address may already carry one.
  // 307 rather than 308 for these alone: where each goes depends on `VIRTUAL_AGENTS_ENABLED`, and a browser keeps a
  // permanent redirect, so a 308 would strand anyone who followed one before the flag changed. The others' targets
  // are fixed.
  const retired = retiredPath(request.nextUrl.pathname, virtualAgentsEnabled());
  if (retired !== undefined) {
    return NextResponse.redirect(new URL(retired, request.nextUrl.origin), 307);
  }
  // The viewer's old ticket address keeps its query, the `path=` it lands on, which `carriesSecret` has already seen.
  // One naming no agent's port is left to the routes, which have none for it, so the person gets the not-found page and
  // its way home rather than a bare 404, signing in first as for any other page.
  const ticket = movedPortTicketPath(request.nextUrl.pathname);
  if (ticket?.kind === "moved") {
    return NextResponse.redirect(new URL(`${ticket.to}${request.nextUrl.search}`, request.nextUrl.origin), 308);
  }
  const moved = ticket === undefined ? movedHubPath(request.nextUrl.pathname) : undefined;
  if (moved !== undefined) {
    return NextResponse.redirect(new URL(`${moved}${request.nextUrl.search}`, request.nextUrl.origin), 308);
  }
  if (!authRequired() || exempt(request.nextUrl.pathname)) {
    return NextResponse.next();
  }
  const secret = sessionSecret();
  if (!secret) {
    return NextResponse.redirect(new URL("/auth/login", request.nextUrl.origin), 307);
  }
  const session = await readSession(request.cookies.get(SESSION_COOKIE)?.value, secret);
  if (session !== undefined) {
    return NextResponse.next();
  }
  const login = new URL("/auth/login", request.nextUrl.origin);
  login.searchParams.set("redirect", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(login, 307);
}

/** `/health` and what is under it, as `src/app/health/` serves. */
function isHealthPath(pathname: string): boolean {
  return pathname === "/health" || pathname.startsWith("/health/");
}

/**
 * Every request to the viewer's host goes to its one route, carrying the path and query the browser asked for.
 *
 * The rewrite stays inside this server only while `nextUrl`'s origin is the one Next's router builds from the listen
 * hostname, as it is with the pod's own name in `HOSTNAME`. Listening on an IP address instead makes Next fetch the
 * route over HTTP as an external rewrite, which the 404 for `VIEWER_ROUTE` on any other host then refuses.
 */
function toViewer(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers);
  headers.set(VIEWER_URL_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.rewrite(new URL(VIEWER_ROUTE, request.nextUrl.origin), { request: { headers } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
