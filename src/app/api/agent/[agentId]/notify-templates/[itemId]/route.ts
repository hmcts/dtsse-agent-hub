import { HttpError, json, noContent, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { UUID_RE } from "@/assistant/artefact-store";
import { requireConversationOfAgent } from "@/assistant/conversation-store";
import { checkNotifyPut } from "@/assistant/notify";
import { askedNotifyVersion, notifyView, removeNotify, writeAgentNotify } from "@/assistant/notify-store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { agentId: string; itemId: string };

const MISSING = "that Notify template no longer exists";

function itemId(params: Params): string {
  if (!UUID_RE.test(params.itemId)) {
    throw new HttpError(404, MISSING);
  }
  return params.itemId;
}

export const GET = ownedAgentRoute<Params>(async ({ agent, params, request }) => {
  const id = itemId(params);
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const version = askedNotifyVersion(request);
  const found = await notifyView(prisma, conversation.id, id, version);
  if (found === null) {
    throw new HttpError(404, version === undefined ? MISSING : `the template does not keep version ${version}`);
  }
  return json(found);
});

export const PUT = ownedAgentRoute<Params>(async ({ agent, params, request }) => {
  const id = itemId(params);
  const body = await readJson(request);
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const checked = checkNotifyPut(body);
  if (!checked.ok) {
    throw new HttpError(400, checked.error);
  }
  const { version, revision } = await writeAgentNotify(prisma, { conversationId: conversation.id, target: { item: id }, body: checked.value });
  return json({ version, revision });
});

export const DELETE = ownedAgentRoute<Params>(async ({ agent, params }) => {
  const id = itemId(params);
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  await removeNotify(prisma, conversation, id);
  return noContent();
});
