import { noContent, parse, readJson } from "@/agent-api/http";
import { virtualRoute } from "@/agent-api/route";
import { prisma } from "@/store/prisma";
import { statusBody } from "@/virtual-agents/schemas";
import { reportStatus } from "@/virtual-agents/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = virtualRoute<{ virtualAgentId: string }>(async ({ virtualAgent, request }) => {
  const body = parse(statusBody, await readJson(request));
  await reportStatus(prisma, virtualAgent.id, body.phase, body.detail);
  return noContent();
});
