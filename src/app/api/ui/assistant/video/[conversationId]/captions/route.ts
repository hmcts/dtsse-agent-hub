import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { readableCaptions } from "@/web/data";
import { uiRefusals, uiViewer } from "../../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The video's captions as WebVTT, from the hub's own origin so the player's track needs no CORS from the blob account. */
export async function GET(request: NextRequest, context: { params: Promise<{ conversationId: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  return await uiRefusals("video captions", async () => {
    const { conversationId } = await context.params;
    const captions = await readableCaptions(viewer, conversationId);
    if (captions === undefined) {
      return errorResponse(404, "that video has no captions you can read");
    }
    return new Response(captions, {
      headers: { "content-type": "text/vtt; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store" }
    });
  });
}
