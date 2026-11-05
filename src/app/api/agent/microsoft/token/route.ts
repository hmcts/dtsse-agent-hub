import { canUseCredentialRoutes } from "@/access/rules";
import { HttpError } from "@/agent-api/http";
import { agentRoute } from "@/agent-api/route";
import { microsoftTokenResponse } from "@/microsoft/route";

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
  return await microsoftTokenResponse(caller.oid, "cli");
});
