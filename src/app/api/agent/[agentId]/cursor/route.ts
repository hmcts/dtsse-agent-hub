import { noContent, parse, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { cursorBody } from "@/agent-api/schemas";
import { storeReadCursor } from "@/agents/store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const body = parse(cursorBody, await readJson(request));
  await storeReadCursor(prisma, agent.id, body.cursor);
  return noContent();
});
