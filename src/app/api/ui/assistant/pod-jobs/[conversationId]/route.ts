import type { NextRequest } from "next/server";
import { errorResponse, readJson } from "@/agent-api/http";
import { requestPodJob } from "@/assistant/pod-job-store";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { uiRefusals, uiViewer } from "../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Asks the conversation's pod to run a pod job, `{kind, args}`, for the signed-in owner alone, and answers the job to
 * read back or why none was started. The person comes from the session cookie and never from the body. See "Pod jobs"
 * in docs/agent-api.md.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ conversationId: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (!virtualAgentsEnabled()) {
    return errorResponse(404, "that is not available on this deployment");
  }
  return await uiRefusals("pod job", async () => {
    const { conversationId } = await context.params;
    const body = (await readJson(request)) as { kind?: unknown; args?: unknown } | null;
    const asked = await requestPodJob(prisma, viewer.oid, conversationId, { kind: body?.kind, args: body?.args });
    return Response.json(asked, { headers: { "cache-control": "no-store" } });
  });
}
