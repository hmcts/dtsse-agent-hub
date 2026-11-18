import { HttpError, json, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { requireConversationOfAgent } from "@/assistant/conversation-store";
import { checkNotifyPut } from "@/assistant/notify";
import { listNotifySummaries, notifySummaryJson, writeAgentNotify } from "@/assistant/notify-store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every one of the conversation's Notify templates, oldest first, without their text. */
export const GET = ownedAgentRoute<{ agentId: string }>(async ({ agent }) => {
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  return json({ notify_templates: (await listNotifySummaries(prisma, conversation.id)).map(notifySummaryJson) });
});

/** Makes a template at version 1, from a body as `PUT /notify` takes it at base 0. */
export const POST = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const body = await readJson(request);
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const checked = checkNotifyPut(body);
  if (!checked.ok) {
    throw new HttpError(400, checked.error);
  }
  if (checked.value.base_version !== 0) {
    throw new HttpError(400, "base_version must be 0 for a new template");
  }
  const { id, version, revision } = await writeAgentNotify(prisma, { conversationId: conversation.id, target: "new", body: checked.value });
  return json({ id, version, revision }, 201);
});
