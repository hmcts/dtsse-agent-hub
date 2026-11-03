import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { fileName } from "@/assistant/downloads";
import { deckPptx } from "@/web/data";
import { uiRefusals, uiViewer } from "../../../../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** One version of a conversation's deck as the .pptx its session built, to download, under the same rule as its pictures. */
export async function GET(request: NextRequest, context: { params: Promise<{ conversationId: string; version: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  return await uiRefusals("deck download", async () => {
    const { conversationId, version } = await context.params;
    const file = /^[1-9]\d{0,8}$/.test(version) ? await deckPptx(viewer, conversationId, Number(version)) : undefined;
    if (file === undefined) {
      return errorResponse(404, "that version of the slides has no .pptx");
    }
    const name = fileName(file.title, "pptx");
    // The plain `filename` is an ASCII stand-in for a title with accents in it, and `filename*` the real one.
    const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
    return new Response(Buffer.from(file.bytes), {
      headers: {
        "content-type": PPTX,
        "content-length": String(file.bytes.length),
        "x-content-type-options": "nosniff",
        "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "cache-control": "no-store"
      }
    });
  });
}
