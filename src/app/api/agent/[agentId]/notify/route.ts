import { HttpError, json, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { requireConversationOfAgent } from "@/assistant/conversation-store";
import { versionParam } from "@/assistant/deck-build";
import { checkNotifyPut } from "@/assistant/notify";
import { notifyView, writeAgentNotify } from "@/assistant/notify-store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The latest version, or with `?version=N` one kept version, with the version the template is at now. */
export const GET = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const asked = new URL(request.url).searchParams.get("version");
  const version = asked === null ? undefined : versionParam(asked);
  if (asked !== null && version === undefined) {
    throw new HttpError(400, "the version must be a whole number from 1");
  }
  const found = await notifyView(prisma, conversation.id, version);
  if (found === null) {
    throw new HttpError(404, version === undefined ? "the conversation has no Notify template" : `the template does not keep version ${version}`);
  }
  return json(found);
});

export const PUT = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const body = await readJson(request);
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const checked = checkNotifyPut(body);
  if (!checked.ok) {
    throw new HttpError(400, checked.error);
  }
  return json(await writeAgentNotify(prisma, { conversationId: conversation.id, body: checked.value }));
});
