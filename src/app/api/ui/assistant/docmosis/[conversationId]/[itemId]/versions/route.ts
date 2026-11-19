import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { docmosisVersions } from "@/web/data";
import { uiRefusals, uiViewer } from "../../../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every kept version of one of a conversation's templates, newest first, under the same rule as the latest. `no-store`, because the next write adds to it. */
export async function GET(request: NextRequest, context: { params: Promise<{ conversationId: string; itemId: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  return await uiRefusals("docmosis history", async () => {
    const { conversationId, itemId } = await context.params;
    const versions = await docmosisVersions(viewer, conversationId, itemId);
    if (versions === undefined) {
      return errorResponse(404, "that chat has no template you can read");
    }
    return Response.json({ versions }, { headers: { "cache-control": "no-store" } });
  });
}
