import { json } from "@/agent-api/http";
import { virtualRoute } from "@/agent-api/route";
import { refreshMicrosoftToken } from "@/auth/entra";
import { authSettings } from "@/auth/settings";
import { mintMicrosoftToken, refreshSettings } from "@/microsoft/token";
import { prisma } from "@/store/prisma";
import { requireStore } from "@/virtual-agents/route-params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A Microsoft Graph access token for the owner of this virtual agent, minted from their Microsoft 365 connection: what
 * a pod's `agent-hub m365` commands send to Graph. Only its own launch token reaches it. 404 until the owner connects.
 */
export const GET = virtualRoute<{ virtualAgentId: string }>(async ({ virtualAgent }) => {
  const settings = refreshSettings(authSettings);
  return json(await mintMicrosoftToken(prisma, requireStore(prisma), virtualAgent.ownerOid, (token) => refreshMicrosoftToken(settings, token)));
});
