import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { versionParam } from "@/assistant/deck-build";
import { readableDocmosis } from "@/web/data";
import { uiRefusals, uiViewer } from "../../../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One kept version of a conversation's template, under the same rule as the latest. `no-store`, because older versions are pruned from under this address. */
export async function GET(request: NextRequest, context: { params: Promise<{ conversationId: string; version: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  return await uiRefusals("docmosis version", async () => {
    const { conversationId, version } = await context.params;
    const number = versionParam(version);
    const found = number === undefined ? undefined : await readableDocmosis(viewer, conversationId, number);
    if (found === undefined) {
      return errorResponse(404, "that version of the template is not there");
    }
    return Response.json(found, { headers: { "cache-control": "no-store" } });
  });
}
