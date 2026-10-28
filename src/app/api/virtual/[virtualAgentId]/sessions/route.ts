import { HttpError, noContent, parse, readJson } from "@/agent-api/http";
import { virtualRoute } from "@/agent-api/route";
import { pendingLookup } from "@/assistant/lookup-store";
import { sessionsReportBody } from "@/assistant/schemas";
import { sessionStream } from "@/assistant/session-stream";
import { pendingWake, pendingWakes, reportSessions } from "@/assistant/store";
import { pendingUploadDeletions } from "@/assistant/upload-disk";
import { RECONNECT_FRAME } from "@/realtime/agent-stream";
import { realtime } from "@/realtime/process";
import { openSseStream, SSE_HEADERS } from "@/realtime/sse";
import { streamLimits } from "@/realtime/stream-slots";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The virtual agent's conversation wakes and closes, and its owner's lookups, counted against its owner's agent streams. */
export const GET = virtualRoute<{ virtualAgentId: string }>(async ({ virtualAgent, request }) => {
  const { hub, listener } = realtime();
  const release = streamLimits().agent.take(virtualAgent.ownerOid);
  if (release === undefined) {
    throw new HttpError(429, "too many open streams for this person");
  }
  const body = openSseStream({
    signal: request.signal,
    onClose: release,
    closingFrame: RECONNECT_FRAME,
    onOpen: sessionStream(virtualAgent.id, {
      hub,
      ready: listener.ready,
      wakes: () => pendingWakes(prisma, virtualAgent.id),
      wake: (conversationId) => pendingWake(prisma, virtualAgent.id, conversationId),
      deletions: () => pendingUploadDeletions(prisma, virtualAgent.id),
      lookup: (lookupId) => pendingLookup(prisma, virtualAgent.id, lookupId)
    })
  });
  return new Response(body, { headers: SSE_HEADERS });
});

export const PUT = virtualRoute<{ virtualAgentId: string }>(async ({ virtualAgent, request }) => {
  await reportSessions(prisma, virtualAgent.id, parse(sessionsReportBody, await readJson(request)));
  return noContent();
});
