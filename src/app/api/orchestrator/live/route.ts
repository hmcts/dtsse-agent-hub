import { json } from "@/agent-api/http";
import { orchestratorRoute } from "@/agent-api/route";
import { prisma } from "@/store/prisma";
import { liveVirtualAgents } from "@/virtual-agents/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = orchestratorRoute(async () => json({ virtual_agents: await liveVirtualAgents(prisma) }));
