import { canUseCredentialRoutes } from "@/access/rules";
import { HttpError, json } from "@/agent-api/http";
import { agentRoute } from "@/agent-api/route";
import { refreshMicrosoftToken } from "@/auth/entra";
import { authSettings } from "@/auth/settings";
import { mintMicrosoftToken, refreshSettings } from "@/microsoft/token";
import { prisma } from "@/store/prisma";
import { requireStore } from "@/virtual-agents/route-params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A Microsoft Graph access token for the person calling, at their own command line, minted from their Microsoft 365
 * connection: always their own, since the owner is the caller's identity. A pod asks its virtual agent's route instead.
 */
export const GET = agentRoute(async ({ caller }) => {
  if (!canUseCredentialRoutes(caller)) {
    throw new HttpError(403, "a virtual agent gets its Microsoft 365 token from /api/virtual/{id}/microsoft/token");
  }
  const settings = refreshSettings(authSettings);
  return json(await mintMicrosoftToken(prisma, requireStore(prisma), caller.oid, (token) => refreshMicrosoftToken(settings, token)));
});
