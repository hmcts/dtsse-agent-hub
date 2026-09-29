import { json } from "@/agent-api/http";
import { agentRoute } from "@/agent-api/route";
import { listMessageableAgents } from "@/agents/store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = agentRoute(async ({ caller }) => json({ agents: await listMessageableAgents(prisma, caller.oid) }));
