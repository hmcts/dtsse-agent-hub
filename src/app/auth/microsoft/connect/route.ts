import type { NextRequest } from "next/server";
import { signInCookie } from "@/auth/cookies";
import { authorizationUrl, beginSignIn, sealSignIn } from "@/auth/entra";
import { safeReturnTo } from "@/auth/guard";
import { redirectAway, redirectTo } from "@/auth/redirect";
import { readSession, SESSION_COOKIE } from "@/auth/session";
import { authRequired, authSettings } from "@/auth/settings";

export const dynamic = "force-dynamic";

/**
 * Where Connect for Microsoft 365 starts: a second sign-in, for someone already signed in, that asks Entra for the
 * Graph permissions and a refresh token. It comes back to the one registered callback, which completes it as a
 * connection because the sealed sign-in says so (`purpose`). Nobody is connected without pressing Connect.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get("redirect"));
  if (!authRequired()) {
    return new Response("Microsoft 365 cannot be connected while sign-in is disabled.\n", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }

  const settings = authSettings();
  if ((await readSession(request.cookies.get(SESSION_COOKIE)?.value, settings.sessionSecret)) === undefined) {
    return redirectTo(`/auth/login?redirect=${encodeURIComponent(returnTo)}`);
  }
  const signIn = beginSignIn(returnTo, "microsoft");
  const response = redirectAway(await authorizationUrl(settings, signIn));
  response.headers.append("set-cookie", signInCookie(await sealSignIn(signIn, settings.sessionSecret)));
  return response;
}
