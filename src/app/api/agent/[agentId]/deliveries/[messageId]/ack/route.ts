import { HttpError, noContent, parseMessageId } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { ackDelivery } from "@/messages/store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = ownedAgentRoute<{ agentId: string; messageId: string }>(async ({ agent, params }) => {
  if (!(await ackDelivery(prisma, agent.id, parseMessageId(params.messageId, "message_id")))) {
    throw new HttpError(404, "no delivery of that message to this agent");
  }
  return noContent();
});
