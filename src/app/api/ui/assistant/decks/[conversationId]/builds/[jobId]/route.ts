import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { readDeckBuild } from "@/assistant/deck-build-store";
import { prisma } from "@/store/prisma";
import { uiRefusals, uiViewer } from "../../../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One of the owner's deck builds as it stands, for the slides panel to read back until it is no longer pending. */
export async function GET(request: NextRequest, context: { params: Promise<{ conversationId: string; jobId: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  return await uiRefusals("deck build", async () => {
    const { conversationId, jobId } = await context.params;
    const build = await readDeckBuild(prisma, viewer.oid, conversationId, jobId);
    if (build === undefined) {
      return errorResponse(404, "that build is not there");
    }
    return Response.json(build, { headers: { "cache-control": "no-store" } });
  });
}
