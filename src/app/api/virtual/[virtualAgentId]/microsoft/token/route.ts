import { virtualRoute } from "@/agent-api/route";
import { microsoftTokenResponse } from "@/microsoft/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A Microsoft Graph access token for the owner of this virtual agent, minted from their Microsoft 365 connection: what
 * a pod's `agent-hub m365` commands send to Graph. Only its own launch token reaches it. 404 until the owner connects.
 */
export const GET = virtualRoute<{ virtualAgentId: string }>(async ({ virtualAgent }) => await microsoftTokenResponse(virtualAgent.ownerOid, "pod"));
