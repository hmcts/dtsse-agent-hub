import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { versionParam } from "@/assistant/deck-build";
import { fileName } from "@/assistant/downloads";
import { docmosisPdf } from "@/web/data";
import { uiRefusals, uiViewer } from "../../../../../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One version's rendered PDF, to show inline in the panel, under the same rule as the template. Only the newest versions keep theirs. */
export async function GET(request: NextRequest, context: { params: Promise<{ conversationId: string; itemId: string; version: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  return await uiRefusals("docmosis pdf", async () => {
    const { conversationId, itemId, version } = await context.params;
    const number = versionParam(version);
    const file = number === undefined ? undefined : await docmosisPdf(viewer, conversationId, itemId, number);
    if (file === undefined) {
      return errorResponse(404, "that version of the template has no PDF");
    }
    const filename = fileName(`${file.name}-v${number}`, "pdf");
    return new Response(Buffer.from(file.bytes), {
      headers: {
        "content-type": "application/pdf",
        "content-length": String(file.bytes.length),
        "x-content-type-options": "nosniff",
        "content-disposition": `inline; filename="${filename.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "cache-control": "no-store"
      }
    });
  });
}
