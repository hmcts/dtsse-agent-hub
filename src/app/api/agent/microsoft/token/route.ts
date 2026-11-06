import { canUseCredentialRoutes } from "@/access/rules";
import { HttpError } from "@/agent-api/http";
import { agentRoute } from "@/agent-api/route";
import { microsoftTokenResponse } from "@/microsoft/route";
import { modelRouteFor } from "@/viewer/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A Microsoft Graph access token for the person calling, at their own command line, minted from their Microsoft 365
 * connection: always their own, since the owner is the caller's identity. A pod asks its virtual agent's route instead.
 *
 * Their route is read from their bearer token's `roles`, as fresh as the token: a role taken away stops the next token
 * they get. `X-Dev-User` carries no role, so with agent auth disabled this always refuses.
 */
export const GET = agentRoute(async ({ caller }) => {
  if (!canUseCredentialRoutes(caller)) {
    throw new HttpError(403, "a virtual agent gets its Microsoft 365 token from /api/virtual/{id}/microsoft/token");
  }
  return await microsoftTokenResponse(caller.oid, "cli", modelRouteFor(caller.aiGateway === true));
});
