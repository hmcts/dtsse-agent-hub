import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { readableDeck } from "@/web/data";
import { uiRefusals, uiViewer } from "../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The latest version of a conversation's deck, outline and all, for the slide viewer to draw: its owner's, or one
 * shared with or offered to the viewer. The page carries only the deck's version, so the viewer reads this as it opens
 * and again each time that version moves on. `no-store`, because the next write replaces it under the same address.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ conversationId: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  return await uiRefusals("deck", async () => {
    const { conversationId } = await context.params;
    const deck = await readableDeck(viewer, conversationId);
    if (deck === undefined || deck === null) {
      return errorResponse(404, "that chat has no slides you can read");
    }
    return Response.json(deck, { headers: { "cache-control": "no-store" } });
  });
}
