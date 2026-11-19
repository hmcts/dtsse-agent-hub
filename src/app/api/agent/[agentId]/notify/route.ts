import { HttpError, json, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { requireConversationOfAgent } from "@/assistant/conversation-store";
import { checkNotifyPut } from "@/assistant/notify";
import { askedNotifyVersion, primaryNotifyView, writeAgentNotify } from "@/assistant/notify-store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The primary template's latest version, or with `?version=N` one kept version, with the version the template is at now. */
export const GET = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const version = askedNotifyVersion(request);
  const found = await primaryNotifyView(prisma, conversation.id, version);
  if (found === null) {
    throw new HttpError(404, version === undefined ? "the conversation has no Notify template" : `the template does not keep version ${version}`);
  }
  return json(found);
});

/** Writes the primary template, and makes it at base 0 while there is none, so a client that knows one template keeps working. */
export const PUT = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const body = await readJson(request);
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const checked = checkNotifyPut(body);
  if (!checked.ok) {
    throw new HttpError(400, checked.error);
  }
  const { version, revision } = await writeAgentNotify(prisma, { conversationId: conversation.id, target: "primary", body: checked.value });
  return json({ version, revision });
});
