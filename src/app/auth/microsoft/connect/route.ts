import { type NextRequest, NextResponse } from "next/server";
import { canConnectMicrosoft } from "@/access/rules";
import { signInCookie } from "@/auth/cookies";
import { authorizationUrl, beginSignIn, sealSignIn } from "@/auth/entra";
import { safeReturnTo, sameOriginPost } from "@/auth/guard";
import { redirectTo } from "@/auth/redirect";
import { readSession, SESSION_COOKIE } from "@/auth/session";
import { authRequired, authSettings } from "@/auth/settings";
import { withConnectOutcome } from "@/microsoft/microsoft";
import { modelRouteFor } from "@/viewer/identity";
import { assistantSettingsPath } from "@/web/home";

export const dynamic = "force-dynamic";

const CONNECTIONS = assistantSettingsPath("connections");

/**
 * Where Connect for Microsoft 365 starts: a second sign-in, for someone already signed in, that asks Entra for the
 * Graph permissions and a refresh token. It comes back to the one registered callback, which completes it as a
 * connection because the sealed sign-in says so (`purpose`). Nobody is connected without pressing Connect, and only
 * someone `canConnectMicrosoft` allows, on the role their session was signed in with, gets as far as Entra; anyone
 * else goes back to settings, which says why.
 *
 * A POST from the hub's own settings page and nothing else (`sameOriginPost`), so another site cannot start one: a
 * link or a cross-site form would otherwise put a Microsoft consent in front of the person that they never asked for.
 */
export async function POST(request: NextRequest): Promise<Response> {
  if (!authRequired()) {
    return text(503, "Microsoft 365 cannot be connected while sign-in is disabled.");
  }
  const settings = authSettings();
  const headers = { secFetchSite: request.headers.get("sec-fetch-site"), origin: request.headers.get("origin") };
  if (!sameOriginPost(headers, new URL(settings.redirectUri).origin)) {
    console.warn("a Microsoft 365 connect that did not come from the hub's own page was refused");
    return text(403, "Connect Microsoft 365 from the Assistant's settings.");
  }

  const form = await request.formData().catch(() => undefined);
  const field = form?.get("redirect");
  const returnTo = safeReturnTo(typeof field === "string" ? field : CONNECTIONS);
  const session = await readSession(request.cookies.get(SESSION_COOKIE)?.value, settings.sessionSecret);
  if (session === undefined) {
    return redirectAfterPost(`/auth/login?redirect=${encodeURIComponent(returnTo)}`);
  }
  if (!canConnectMicrosoft(modelRouteFor(session.aiGateway))) {
    return redirectAfterPost(withConnectOutcome(returnTo, "unavailable"));
  }
  const signIn = beginSignIn(returnTo, "microsoft");
  // 303, so the browser follows it with a GET: a 307 would send the form on to Entra.
  const response = NextResponse.redirect(await authorizationUrl(settings, signIn), 303);
  response.headers.append("set-cookie", signInCookie(await sealSignIn(signIn, settings.sessionSecret)));
  return response;
}

/** A link to the old address goes to the settings, where Connect is, rather than starting anything. */
export async function GET(): Promise<Response> {
  return redirectTo(CONNECTIONS);
}

function redirectAfterPost(path: string): Response {
  return new NextResponse(null, { status: 303, headers: { location: path } });
}

function text(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
