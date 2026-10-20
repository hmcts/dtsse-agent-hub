import { type NextRequest, NextResponse } from "next/server";
import { carriesSecret, exempt } from "@/auth/guard";
import { readSession, SESSION_COOKIE } from "@/auth/session";
import { authRequired, sessionSecret } from "@/auth/settings";
import { requestHost, VIEWER_ROUTE, VIEWER_URL_HEADER, viewerHost, viewerSettings } from "@/port-viewer/settings";

/**
 * Sends a person with no session to sign in, before anything renders. Named `proxy`: Next 16 replaced the
 * `middleware` file convention with this one.
 *
 * `authSettings()` is deliberately not called here: it throws on incomplete configuration, and throwing from the
 * proxy would take `/health` down too. The login route calls it, where the error is visible without costing probes.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  // Ahead of everything else: the viewer's host serves agents' pages, whose paths and queries are theirs, and never
  // the hub's own, even when the rest of the viewer's settings are missing.
  const host = viewerHost();
  if (host !== undefined && requestHost(request.headers, request.nextUrl.host) === host) {
    return viewerSettings() === undefined ? new NextResponse(null, { status: 404 }) : toViewer(request);
  }
  if (pathname === VIEWER_ROUTE || pathname.startsWith(`${VIEWER_ROUTE}/`)) {
    return new NextResponse(null, { status: 404 });
  }
  // The redirect Next makes itself without `skipTrailingSlashRedirect`, which the viewer needs off: a pod's `/docs/` is
  // not its `/docs`.
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return NextResponse.redirect(new URL(`${pathname.replace(/\/+$/, "") || "/"}${search}`, request.nextUrl.origin), 308);
  }
  // Ahead of the sign-in check, which would otherwise copy the query into the login's `redirect=`.
  if (carriesSecret(request.method, request.nextUrl.pathname, request.nextUrl.searchParams)) {
    return NextResponse.redirect(new URL(request.nextUrl.pathname, request.nextUrl.origin), 303);
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
