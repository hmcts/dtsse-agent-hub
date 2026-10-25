import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { downloadableUpload, uploadBytes } from "@/assistant/upload-store";
import { storedNameOf, type UploadRefusal } from "@/assistant/uploads";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { uiRefusals, uiViewer } from "../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The person's own attached file, back. Their only route to the bytes once the browser that picked it has moved on.
 *
 * Streamed part row by part row by `uploadBytes`, which holds one at a time; a `Buffer.concat` of the parts, or a
 * single query for all of them, would put 25 MB on a heap capped at 768 MB across two replicas and undo the reason
 * the file is in parts at all.
 *
 * Who may do this, and until when, is `attachmentDownload` in `src/access/rules.ts`. The window is short on purpose —
 * see `uploadHeldUntil` — and `MessageAttachments.tsx` offers no download outside it, so a 410 from here is a race
 * with the sweep rather than something the person was invited to try.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ uploadId: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (!virtualAgentsEnabled()) {
    return errorResponse(404, "attaching files is not available on this deployment", { reason: "unavailable" satisfies UploadRefusal });
  }
  return await uiRefusals("download attachment", async () => {
    const { uploadId } = await context.params;
    const upload = await downloadableUpload(prisma, viewer.oid, uploadId);
    return new Response(uploadBytes(prisma, upload), {
      headers: {
        // The media type the browser claimed on the way up, never re-derived from the bytes, so it is paired with
        // `nosniff` and an `attachment` disposition: the response is same-origin, and a file someone claimed was
        // `text/html` must be saved rather than rendered as a page of this site.
        "content-type": upload.mediaType,
        "content-length": String(upload.bytes),
        "x-content-type-options": "nosniff",
        // The sanitised name, not the person's own: it is already constrained to letters, digits, dots, hyphens and
        // underscores by a CHECK, and re-sanitised here so the header stays safe even if that were ever loosened. A
        // `filename*` of the original would put their accents back and their quotes, semicolons and newlines with it.
        "content-disposition": `attachment; filename="${storedNameOf(upload.storedName)}"`,
        // Nothing between here and the person keeps a copy: the bytes are someone's private file, and the window
        // they are held for is the hub's to end.
        "cache-control": "no-store"
      }
    });
  });
}
