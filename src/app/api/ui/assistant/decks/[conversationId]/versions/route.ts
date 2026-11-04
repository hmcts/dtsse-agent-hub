import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { deckVersions } from "@/web/data";
import { uiRefusals, uiViewer } from "../../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every kept version of a conversation's deck, newest first, for the slides panel's history: its owner's, or one
 * shared with or offered to the viewer. `no-store`, because the next write adds to it under the same address.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ conversationId: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  return await uiRefusals("deck history", async () => {
    const { conversationId } = await context.params;
    const versions = await deckVersions(viewer, conversationId);
    if (versions === undefined) {
      return errorResponse(404, "that chat has no slides you can read");
    }
    return Response.json(versions, { headers: { "cache-control": "no-store" } });
  });
}
