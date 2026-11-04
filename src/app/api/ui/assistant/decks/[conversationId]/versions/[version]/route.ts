import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { versionParam } from "@/assistant/deck-build";
import { deckVersion } from "@/web/data";
import { uiRefusals, uiViewer } from "../../../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One kept version of a conversation's deck, outline and all, for the slides panel to show read-only, under the same
 * rule as the latest. `no-store`, because the version is pruned from under this address once 100 newer ones exist.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ conversationId: string; version: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  return await uiRefusals("deck version", async () => {
    const { conversationId, version } = await context.params;
    const number = versionParam(version);
    const found = number === undefined ? undefined : await deckVersion(viewer, conversationId, number);
    if (found === undefined) {
      return errorResponse(404, "that version of the slides is not there");
    }
    return Response.json(found, { headers: { "cache-control": "no-store" } });
  });
}
