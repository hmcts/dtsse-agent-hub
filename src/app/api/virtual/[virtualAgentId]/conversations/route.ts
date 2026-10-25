import { json } from "@/agent-api/http";
import { virtualRoute } from "@/agent-api/route";
import { conversationIdsOf } from "@/assistant/store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The virtual agent's conversations, for its pod to reconcile the attachment directories under `/workspace/uploads`
 * against. The sessions stream's `close` covers a conversation deleted while the pod is up; this covers one deleted
 * while it was stopped, which sends no `close` the pod is there to hear.
 */
export const GET = virtualRoute<{ virtualAgentId: string }>(async ({ virtualAgent }) => {
  const ids = await conversationIdsOf(prisma, virtualAgent.id);
  return json({ conversations: ids.map((id) => ({ id })) });
});
