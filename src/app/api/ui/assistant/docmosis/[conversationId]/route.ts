import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { readableDocmosis } from "@/web/data";
import { uiRefusals, uiViewer } from "../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The latest version of a conversation's Docmosis template, schema and data and all, for the template panel: its
 * owner's, or one shared with or offered to the viewer. `no-store`, because the next write replaces it under the same
 * address.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ conversationId: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  return await uiRefusals("docmosis", async () => {
    const { conversationId } = await context.params;
    const template = await readableDocmosis(viewer, conversationId);
    if (template === undefined) {
      return errorResponse(404, "that chat has no template you can read");
    }
    return Response.json(template, { headers: { "cache-control": "no-store" } });
  });
}
