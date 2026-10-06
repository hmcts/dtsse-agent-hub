import { noContent, parse, readJson } from "@/agent-api/http";
import { virtualRoute } from "@/agent-api/route";
import { prisma } from "@/store/prisma";
import { portsBody } from "@/virtual-agents/schemas";
import { reportPorts } from "@/virtual-agents/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PUT = virtualRoute<{ virtualAgentId: string }>(async ({ virtualAgent, request }) => {
  const body = parse(portsBody, await readJson(request));
  await reportPorts(prisma, virtualAgent.id, { ports: body.ports, localOnly: body.local_only });
  return noContent();
});
