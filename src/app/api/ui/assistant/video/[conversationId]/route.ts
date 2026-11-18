import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { readableVideo } from "@/web/data";
import { uiRefusals, uiViewer } from "../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A conversation's journey video for the panel, with a read URL for the MP4 that is good for an hour: its owner's, or
 * one shared with or offered to the viewer. `no-store`, because the URL expires and the next video replaces this one.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ conversationId: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  return await uiRefusals("video", async () => {
    const { conversationId } = await context.params;
    const video = await readableVideo(viewer, conversationId);
    if (video === undefined) {
      return errorResponse(404, "that chat has no video you can watch");
    }
    return Response.json(video, { headers: { "cache-control": "no-store" } });
  });
}
