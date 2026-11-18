import { noContent, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { requireConversationOfAgent } from "@/assistant/conversation-store";
import { getTemplate, putTemplate, templateId } from "@/assistant/docmosis-agent";
import { removeDocmosisTemplate } from "@/assistant/docmosis-store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { agentId: string; itemId: string };

export const GET = ownedAgentRoute<Params>(async ({ agent, request, params }) => await getTemplate(agent, request, templateId(params.itemId)));

export const PUT = ownedAgentRoute<Params>(async ({ agent, request, params }) => await putTemplate(agent, await readJson(request), templateId(params.itemId)));

export const DELETE = ownedAgentRoute<Params>(async ({ agent, params }) => {
  const item = templateId(params.itemId);
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  await removeDocmosisTemplate(prisma, conversation, item);
  return noContent();
});
