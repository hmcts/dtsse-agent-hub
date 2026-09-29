import { type NextRequest, NextResponse } from "next/server";
import { exempt } from "@/auth/guard";
import { readSession, SESSION_COOKIE } from "@/auth/session";
import { authRequired, sessionSecret } from "@/auth/settings";

/**
 * Sends a person with no session to sign in, before anything renders. Named `proxy`: Next 16 replaced the
 * `middleware` file convention with this one.
 *
 * `authSettings()` is deliberately not called here: it throws on incomplete configuration, and throwing from the
 * proxy would take `/health` down too. The login route calls it, where the error is visible without costing probes.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
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

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
