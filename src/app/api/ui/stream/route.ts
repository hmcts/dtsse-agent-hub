import type { NextRequest } from "next/server";
import { grantsHeldBy } from "@/access/load";
import { canViewAgent } from "@/access/rules";
import { errorResponse } from "@/agent-api/http";
import { findAgent, isUuid } from "@/agents/store";
import { parseMatch, viewScope } from "@/channels/rules";
import { loadThreadMessage } from "@/messages/direct-thread";
import { realtime } from "@/realtime/process";
import { openSseStream, SSE_HEADERS } from "@/realtime/sse";
import { streamLimits } from "@/realtime/stream-slots";
import { sharedPostLoader, uiStream } from "@/realtime/ui-stream";
import { prisma } from "@/store/prisma";
import { uiViewer } from "../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live updates for one browser tab. `?topics=a,b&mode=any|all` watches posts on those topics and `?everything=1`
 * every post, and `?agent=<id>` an agent's thread;
 * agent status changes the viewer may see are always sent. An agent the viewer cannot see is refused as missing.
 * A viewer already holding their limit of streams on this pod is refused with 429, which the client backs off from.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  const query = request.nextUrl.searchParams;
  const asked = viewScope(query);
  if ("error" in asked) {
    return errorResponse(400, asked.error);
  }

  const agentId = query.get("agent");
  let agent = null;
  if (agentId !== null) {
    const found = isUuid(agentId) ? await findAgent(prisma, agentId) : undefined;
    if (found === undefined || !canViewAgent(viewer.oid, found, await grantsHeldBy(prisma, viewer.oid))) {
      return errorResponse(404, "no such agent");
    }
    agent = { id: found.id, ownerOid: found.ownerOid };
  }

  const { hub, listener } = realtime();
  const release = streamLimits().ui.take(viewer.oid);
  if (release === undefined) {
    return new Response("too many open streams", { status: 429 });
  }
  const body = openSseStream({
    signal: request.signal,
    onClose: release,
    onOpen: uiStream(
      { topics: asked.scope, match: parseMatch(query.get("mode")), agent },
      {
        hub,
        listener,
        viewerOid: viewer.oid,
        grants: () => grantsHeldBy(prisma, viewer.oid),
        post: sharedPostLoader(prisma),
        direct: (id) => loadThreadMessage(prisma, id)
      }
    )
  });
  return new Response(body, { headers: SSE_HEADERS });
}
