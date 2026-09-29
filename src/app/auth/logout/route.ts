import { clearedSessionCookie } from "@/auth/cookies";
import { signOutUrl } from "@/auth/entra";
import { HOME } from "@/auth/guard";
import { redirectAway, redirectTo } from "@/auth/redirect";
import { authRequired, authSettings } from "@/auth/settings";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (!authRequired()) {
    return redirectTo(HOME);
  }

  const settings = authSettings();
  // Entra is asked to forget the person too, or the next visit signs straight back in without a prompt.
  const away = await signOutUrl(settings);
  const response = away === undefined ? redirectTo(HOME) : redirectAway(away);
  response.headers.append("set-cookie", clearedSessionCookie());
  return response;
}
