import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { notifyVersions } from "@/web/data";
import { uiRefusals, uiViewer } from "../../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every kept version of a conversation's Notify template, newest first, under the same rule as the latest. `no-store`, because the next write adds to it. */
export async function GET(request: NextRequest, context: { params: Promise<{ conversationId: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  return await uiRefusals("notify history", async () => {
    const { conversationId } = await context.params;
    const versions = await notifyVersions(viewer, conversationId);
    if (versions === undefined) {
      return errorResponse(404, "that chat has no Notify template you can read");
    }
    return Response.json({ versions }, { headers: { "cache-control": "no-store" } });
  });
}
