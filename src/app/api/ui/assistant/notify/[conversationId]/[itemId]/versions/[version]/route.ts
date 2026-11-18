import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { versionParam } from "@/assistant/deck-build";
import { readableNotify } from "@/web/data";
import { uiRefusals, uiViewer } from "../../../../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One kept version of one of a conversation's Notify templates, under the same rule as the latest. `no-store`, because older versions are pruned from under this address. */
export async function GET(request: NextRequest, context: { params: Promise<{ conversationId: string; itemId: string; version: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  return await uiRefusals("notify version", async () => {
    const { conversationId, itemId, version } = await context.params;
    const number = versionParam(version);
    const found = number === undefined ? undefined : await readableNotify(viewer, conversationId, itemId, number);
    if (found === undefined) {
      return errorResponse(404, "that version of the Notify template is not there");
    }
    return Response.json(found, { headers: { "cache-control": "no-store" } });
  });
}
