import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { deckAsset } from "@/web/data";
import { uiRefusals, uiViewer } from "../../../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One picture of a conversation's deck, for the slide viewer: its owner's, or one shared with or offered to the viewer.
 * A picture is named by the digest of its bytes, so it can never change under its address, and is cached for good;
 * `private`, because it is one person's and those they shared with, never a shared cache's.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ conversationId: string; sha256: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  return await uiRefusals("deck picture", async () => {
    const { conversationId, sha256 } = await context.params;
    const asset = await deckAsset(viewer, conversationId, sha256);
    if (asset === undefined) {
      return errorResponse(404, "that picture is not there");
    }
    return new Response(Buffer.from(asset.bytes), {
      headers: {
        // What the hub read from the bytes when they were stored, never what the uploader said they were.
        "content-type": asset.mime,
        "content-length": String(asset.bytes.length),
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=31536000, immutable"
      }
    });
  });
}
