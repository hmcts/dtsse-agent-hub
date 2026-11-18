import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { readPodJob } from "@/assistant/pod-job-store";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { uiRefusals, uiViewer } from "../../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One of the owner's pod jobs as it stands, for the panel to read back until it is no longer pending. */
export async function GET(request: NextRequest, context: { params: Promise<{ conversationId: string; jobId: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (!virtualAgentsEnabled()) {
    return errorResponse(404, "that is not available on this deployment");
  }
  return await uiRefusals("pod job", async () => {
    const { conversationId, jobId } = await context.params;
    const job = await readPodJob(prisma, viewer.oid, conversationId, jobId);
    if (job === undefined) {
      return errorResponse(404, "that job is not there");
    }
    return Response.json(job, { headers: { "cache-control": "no-store" } });
  });
}
