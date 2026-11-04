import type { NextRequest } from "next/server";
import { clearedSignInCookie, SIGN_IN_COOKIE, sessionCookie } from "@/auth/cookies";
import { completeMicrosoftConnect, completeSignIn, readSignIn, SignInFailed, type SignInState } from "@/auth/entra";
import { HOME, safeReturnTo } from "@/auth/guard";
import { redirectTo } from "@/auth/redirect";
import { readSession, SESSION_COOKIE, sealSession } from "@/auth/session";
import { type AuthSettings, authRequired, authSettings } from "@/auth/settings";
import { credentialBackend } from "@/credentials/backend";
import { putCredential } from "@/credentials/store";
import { serialiseSignIn } from "@/microsoft/microsoft";
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

  if (signIn.purpose === "microsoft") {
    return await connectMicrosoft(request, settings, callbackUrl, signIn);
  }

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

/**
 * The end of Connect for Microsoft 365: the person must still be signed in, as the account they connected, and their
 * connection is then the one credential of theirs only this writes. It sets no session: they already have one.
 */
async function connectMicrosoft(request: NextRequest, settings: AuthSettings, callbackUrl: URL, signIn: SignInState): Promise<Response> {
  const session = await readSession(request.cookies.get(SESSION_COOKIE)?.value, settings.sessionSecret);
  if (session === undefined) {
    console.warn("a Microsoft 365 connection came back with nobody signed in, so it was not kept");
    return redirectTo(`/auth/login?redirect=${encodeURIComponent(safeReturnTo(signIn.returnTo))}`);
  }
  let connection: Awaited<ReturnType<typeof completeMicrosoftConnect>>;
  try {
    connection = await completeMicrosoftConnect(settings, callbackUrl, signIn, session);
  } catch (error) {
    console.warn(`a Microsoft 365 connection could not be completed: ${error instanceof SignInFailed ? error.message : String(error)}`);
    return signInRefused();
  }
  const backend = credentialBackend(prisma);
  if (!backend.available) {
    console.warn(`a Microsoft 365 connection could not be kept: ${backend.reason}`);
    return new Response(`We could not keep your Microsoft 365 connection: ${backend.reason}\n`, {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }
  await putCredential(prisma, backend.store, {
    actorOid: session.oid,
    ownerOid: session.oid,
    kind: "microsoft",
    value: serialiseSignIn(connection),
    via: "web"
  });
  console.info(`${session.name} connected Microsoft 365`);
  const response = redirectTo(safeReturnTo(signIn.returnTo));
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
