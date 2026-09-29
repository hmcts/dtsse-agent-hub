import type { NextRequest } from "next/server";
import { signInCookie } from "@/auth/cookies";
import { authorizationUrl, beginSignIn, sealSignIn } from "@/auth/entra";
import { safeReturnTo } from "@/auth/guard";
import { redirectAway, redirectTo } from "@/auth/redirect";
import { authRequired, authSettings } from "@/auth/settings";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get("redirect"));

  if (!authRequired()) {
    return redirectTo(returnTo);
  }

  const settings = authSettings();
  const signIn = beginSignIn(returnTo);
  const response = redirectAway(await authorizationUrl(settings, signIn));
  response.headers.append("set-cookie", signInCookie(await sealSignIn(signIn, settings.sessionSecret)));
  return response;
}
