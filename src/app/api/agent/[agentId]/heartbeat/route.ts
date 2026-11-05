import { json, noContent, parse, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { heartbeatBody } from "@/agent-api/schemas";
import { heartbeat } from "@/agents/store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const body = parse(heartbeatBody, await readJson(request));
  const claim = await heartbeat(prisma, agent.id, body.status, body.name ?? null, body.skills, body.name_source, body.client_features);
  // A claim is answered with the claim as stored, which is how the client tells this hub from one that drops the field.
  return body.client_features === undefined ? noContent() : json({ client_features: claim ?? null });
});
