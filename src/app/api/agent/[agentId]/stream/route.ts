import { HttpError } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { queuedDeliveries, queuedDelivery } from "@/messages/store";
import { agentStream } from "@/realtime/agent-stream";
import { realtime } from "@/realtime/process";
import { openSseStream, SSE_HEADERS } from "@/realtime/sse";
import { streamLimits } from "@/realtime/stream-slots";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `Last-Event-ID` is accepted for the log only: acks, not the stream position, decide what is resent. */
export const GET = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const { hub } = realtime();
  const lastEventId = request.headers.get("last-event-id");
  if (lastEventId !== null) {
    console.info(`agent ${agent.id} reconnected after event ${lastEventId.slice(0, 32)}`);
  }
  const release = streamLimits().agent.take(agent.ownerOid);
  if (release === undefined) {
    throw new HttpError(429, "too many open streams for this person");
  }
  const body = openSseStream({
    signal: request.signal,
    onClose: release,
    onOpen: agentStream(agent.id, {
      hub,
      queued: () => queuedDeliveries(prisma, agent.id),
      queuedOne: (messageId) => queuedDelivery(prisma, agent.id, messageId)
    })
  });
  return new Response(body, { headers: SSE_HEADERS });
});
