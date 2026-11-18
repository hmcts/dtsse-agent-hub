import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { readableNotify } from "@/web/data";
import { uiRefusals, uiViewer } from "../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The latest version of a conversation's Notify template, draft, personalisation and Notify's preview and all, for the
 * Notify panel: its owner's, or one shared with or offered to the viewer. `no-store`, because the next write replaces
 * it under the same address.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ conversationId: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  return await uiRefusals("notify", async () => {
    const { conversationId } = await context.params;
    const template = await readableNotify(viewer, conversationId);
    if (template === undefined) {
      return errorResponse(404, "that chat has no Notify template you can read");
    }
    return Response.json(template, { headers: { "cache-control": "no-store" } });
  });
}
