import { NextResponse } from "next/server";

/**
 * A relative redirect. A route handler's `request.nextUrl` carries the pod's listen address rather than the public
 * host, so an absolute URL built from it would send the browser to `https://<pod-name>:3000/…`; a relative
 * `Location` resolves against the address the browser actually used.
 */
export function redirectTo(path: string): NextResponse {
  return new NextResponse(null, { status: 307, headers: { location: path } });
}

/** Somewhere off this service, where an absolute URL is the only option. */
export function redirectAway(url: URL): NextResponse {
  return NextResponse.redirect(url, 307);
}
