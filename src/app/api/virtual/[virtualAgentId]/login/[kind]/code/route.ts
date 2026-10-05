import { json, noContent } from "@/agent-api/http";
import { virtualRoute } from "@/agent-api/route";
import { prisma } from "@/store/prisma";
import { takePastedCode } from "@/virtual-agents/logins";
import { pathKind, requireSessionSecret } from "@/virtual-agents/route-params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The code the owner pasted, once: it is deleted as it is read. 204 until there is one. */
export const GET = virtualRoute<{ virtualAgentId: string; kind: string }>(async ({ virtualAgent, params }) => {
  const kind = pathKind(params.kind);
  const code = await takePastedCode(prisma, virtualAgent, kind, requireSessionSecret());
  return code === undefined ? noContent() : json({ code });
});
