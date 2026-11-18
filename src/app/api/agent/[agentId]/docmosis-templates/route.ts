import { HttpError, json, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { requireConversationOfAgent } from "@/assistant/conversation-store";
import { checkDocmosisPut } from "@/assistant/docmosis";
import { docmosisSummaryJson, listDocmosisSummaries, writeAgentDocmosis } from "@/assistant/docmosis-store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every one of the conversation's Docmosis templates, oldest first, without their schema and data. */
export const GET = ownedAgentRoute<{ agentId: string }>(async ({ agent }) => {
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  return json({ docmosis_templates: (await listDocmosisSummaries(prisma, conversation.id)).map(docmosisSummaryJson) });
});

/** Makes a new template at version 1, whatever the conversation holds; its `base_version` is 0. */
export const POST = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const body = await readJson(request);
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const checked = checkDocmosisPut(body);
  if (!checked.ok) {
    throw new HttpError(400, checked.error);
  }
  return json(await writeAgentDocmosis(prisma, { conversationId: conversation.id, create: true, body: checked.value, agent }), 201);
});
