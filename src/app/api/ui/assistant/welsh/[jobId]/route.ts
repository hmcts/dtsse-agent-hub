import type { NextRequest } from "next/server";
import { errorResponse, json } from "@/agent-api/http";
import { readWelsh } from "@/assistant/welsh-store";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { uiRefusals, uiViewer } from "../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Where one of the signed-in person's Welsh jobs has got to. Anybody else's job is not found. */
export async function GET(request: NextRequest, context: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (!virtualAgentsEnabled()) {
    return errorResponse(404, "Welsh translations are not available on this deployment");
  }
  return await uiRefusals("welsh job read", async () => {
    const { jobId } = await context.params;
    const answer = await readWelsh(prisma, viewer.oid, jobId);
    return answer === undefined ? errorResponse(404, "that job is not there any more") : json(answer);
  });
}
