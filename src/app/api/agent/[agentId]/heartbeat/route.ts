import { noContent, parse, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { heartbeatBody } from "@/agent-api/schemas";
import { heartbeat } from "@/agents/store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const body = parse(heartbeatBody, await readJson(request));
  await heartbeat(prisma, agent.id, body.status, body.name ?? null, body.skills);
  return noContent();
});
