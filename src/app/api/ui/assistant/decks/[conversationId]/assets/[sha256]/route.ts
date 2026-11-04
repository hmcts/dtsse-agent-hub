import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { deckAsset, deckAssetReadable } from "@/web/data";
import { uiRefusals, uiViewer } from "../../../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `private, no-cache`: the browser may keep a copy, but asks again before every use, so a share taken away stops
 * showing the picture on the next view rather than whenever the cache lets it go. A picture is named by the digest of
 * its bytes, so the digest is its ETag and a revalidation that still passes `canReadDeck` costs a `304` and no bytes.
 */
const CACHE = "private, no-cache";

function matches(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) {
    return false;
  }
  return ifNoneMatch.split(",").some((tag) => {
    const value = tag.trim();
    return value === "*" || value.replace(/^W\//, "") === etag;
  });
}

/** One picture of a conversation's deck, for the slide viewer: its owner's, or one shared with or offered to the viewer. */
export async function GET(request: NextRequest, context: { params: Promise<{ conversationId: string; sha256: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  return await uiRefusals("deck picture", async () => {
    const { conversationId, sha256 } = await context.params;
    const etag = `"${sha256}"`;
    if (matches(request.headers.get("if-none-match"), etag) && (await deckAssetReadable(viewer, conversationId, sha256))) {
      return new Response(null, { status: 304, headers: { etag, "cache-control": CACHE } });
    }
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
        etag,
        "cache-control": CACHE
      }
    });
  });
}
