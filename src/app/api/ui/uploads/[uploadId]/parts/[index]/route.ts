import type { NextRequest } from "next/server";
import { errorResponse, HttpError, json } from "@/agent-api/http";
import { readBytes } from "@/assistant/upload-body";
import { putUploadPart, writableUpload } from "@/assistant/upload-store";
import { partIndexOf, partLength, type UploadRefusal, uploadsEnabled } from "@/assistant/uploads";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { uiRefusals, uiViewer } from "../../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One part of a file, as raw bytes. The body is read by `readBytes`, bounded at exactly the length this part should
 * be, and inserted as one row; nothing here holds a second part, and nothing holds the file.
 *
 * **A single `await request.arrayBuffer()` would undo all of that** and put the whole 25 MB on a heap capped at
 * 768 MB across two replicas. The part size itself is in `src/assistant/uploads.ts`, with the ingress timeout that
 * sets it.
 */
export async function PUT(request: NextRequest, context: { params: Promise<{ uploadId: string; index: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (!virtualAgentsEnabled() || !uploadsEnabled()) {
    return errorResponse(404, "attaching files is not available on this deployment", { reason: "unavailable" satisfies UploadRefusal });
  }
  return await uiRefusals("upload part", async () => {
    const params = await context.params;
    const upload = await writableUpload(prisma, viewer.oid, params.uploadId);
    const index = partIndexOf(params.index, upload.bytes);
    if (index === undefined) {
      throw new HttpError(404, "no such part of this file", { reason: "no_such_upload" satisfies UploadRefusal });
    }
    const data = await readBytes(request, partLength(upload.bytes, index));
    return json(await putUploadPart(prisma, upload, index, data));
  });
}
