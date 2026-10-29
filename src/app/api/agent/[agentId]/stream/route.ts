import { HttpError } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { assistantFrame } from "@/assistant/store";
import type { StreamedDirect } from "@/messages/shape";
import { queuedDeliveries, queuedDelivery } from "@/messages/store";
import { agentStream, RECONNECT_FRAME } from "@/realtime/agent-stream";
import { realtime } from "@/realtime/process";
import { openSseStream, SSE_HEADERS } from "@/realtime/sse";
import { streamLimits } from "@/realtime/stream-slots";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `Last-Event-ID` is accepted for the log only: acks, not the stream position, decide what is resent. */
export const GET = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const { hub, listener } = realtime();
  const lastEventId = request.headers.get("last-event-id");
  if (lastEventId !== null) {
    console.info(`agent ${agent.id} reconnected after event ${lastEventId.slice(0, 32)}`);
  }
  const release = streamLimits().agent.take(agent.ownerOid);
  if (release === undefined) {
    throw new HttpError(429, "too many open streams for this person");
  }
  // A conversation's session is told the conversation's product and document version with every message, read as
  // each is sent, so a change of product reaches the next message whether it was queued before or after it. The
  // message id goes in too, because the frame also names that message's attachments.
  //
  // `ownerOnly` is the pod kind of conversation, which is the only one with an Assistant frame to send: the pod's
  // session reads the product, the document and the exports from it. A session on a laptop is told none of that.
  const podConversation = agent.ownerOnly;
  const withAssistant = async (direct: StreamedDirect): Promise<StreamedDirect> => {
    if (!podConversation) {
      return direct;
    }
    const assistant = await assistantFrame(prisma, agent.id, BigInt(direct.message.id));
    return assistant === undefined ? direct : { ...direct, assistant: { ...assistant } };
  };
  const body = openSseStream({
    signal: request.signal,
    onClose: release,
    closingFrame: RECONNECT_FRAME,
    onOpen: agentStream(agent.id, {
      hub,
      ready: listener.ready,
      queued: async () => await Promise.all((await queuedDeliveries(prisma, agent.id)).map(withAssistant)),
      queuedOne: async (messageId) => {
        const direct = await queuedDelivery(prisma, agent.id, messageId);
        return direct === undefined ? undefined : await withAssistant(direct);
      }
    })
  });
  return new Response(body, { headers: SSE_HEADERS });
});
