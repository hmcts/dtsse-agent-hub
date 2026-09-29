import { noContent } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { markOffline } from "@/agents/store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = ownedAgentRoute<{ agentId: string }>(async ({ agent }) => {
  await markOffline(prisma, agent.id);
  return noContent();
});
