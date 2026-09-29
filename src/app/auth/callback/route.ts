import type { NextRequest } from "next/server";
import { clearedSignInCookie, SIGN_IN_COOKIE, sessionCookie } from "@/auth/cookies";
import { completeSignIn, readSignIn, SignInFailed } from "@/auth/entra";
import { HOME, safeReturnTo } from "@/auth/guard";
import { redirectTo } from "@/auth/redirect";
import { sealSession } from "@/auth/session";
import { authRequired, authSettings } from "@/auth/settings";
import { prisma } from "@/store/prisma";
import { upsertUser } from "@/users/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where Entra returns the person, and the only place a session is created. Failures are vague to the browser and
 * specific to the log.
 */
export async function GET(request: NextRequest): Promise<Response> {
  if (!authRequired()) {
    return redirectTo(HOME);
  }

  const settings = authSettings();
  const signIn = await readSignIn(request.cookies.get(SIGN_IN_COOKIE)?.value, settings.sessionSecret);

  if (signIn === undefined) {
    console.warn("a callback arrived with no sign-in in flight, so it was sent back to start again");
    return redirectTo("/auth/login");
  }

  // The registered redirect URI rather than `request.nextUrl`, which carries the pod's listen address: the token
  // request's `redirect_uri` is derived from this URL and must match the registration exactly.
  const callbackUrl = new URL(`${settings.redirectUri}${request.nextUrl.search}`);

  let session: Awaited<ReturnType<typeof completeSignIn>>;
  try {
    session = await completeSignIn(settings, callbackUrl, signIn);
  } catch (error) {
    console.warn(`a sign-in could not be completed: ${error instanceof SignInFailed ? error.message : String(error)}`);
    return signInRefused();
  }

  await upsertUser(prisma, session);

  console.info(`${session.name} signed in`);
  const response = redirectTo(safeReturnTo(signIn.returnTo));
  response.headers.append("set-cookie", sessionCookie(await sealSession(session, settings.sessionSecret)));
  response.headers.append("set-cookie", clearedSignInCookie());
  return response;
}

/** Two tabs signing in at once overwrite one sign-in cookie, so the refused tab needs a way to start again. */
function signInRefused(): Response {
  const body =
    "We could not complete your sign-in.\n\n" +
    "This usually means the attempt took too long, or another sign-in was started in a different tab.\n\n" +
    "Start again: /auth/login\n";
  const response = new Response(body, { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  response.headers.append("set-cookie", clearedSignInCookie());
  return response;
}
