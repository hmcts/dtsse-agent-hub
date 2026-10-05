import { json, parse, readJson } from "@/agent-api/http";
import { orchestratorRoute } from "@/agent-api/route";
import { prisma } from "@/store/prisma";
import { claimBody } from "@/virtual-agents/schemas";
import { claimVirtualAgents } from "@/virtual-agents/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = orchestratorRoute(async ({ request }) => {
  const { cluster } = parse(claimBody, await readJson(request));
  return json(await claimVirtualAgents(prisma, cluster));
});
