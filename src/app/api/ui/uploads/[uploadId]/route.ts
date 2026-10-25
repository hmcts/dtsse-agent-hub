import type { NextRequest } from "next/server";
import { errorResponse, noContent } from "@/agent-api/http";
import { discardUpload, writableUpload } from "@/assistant/upload-store";
import { type UploadRefusal, uploadsEnabled } from "@/assistant/uploads";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { uiRefusals, uiViewer } from "../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Throws away an upload the person removed from the composer, with whatever parts had arrived. */
export async function DELETE(request: NextRequest, context: { params: Promise<{ uploadId: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (!virtualAgentsEnabled() || !uploadsEnabled()) {
    return errorResponse(404, "attaching files is not available on this deployment", { reason: "unavailable" satisfies UploadRefusal });
  }
  return await uiRefusals("discard upload", async () => {
    const { uploadId } = await context.params;
    const upload = await writableUpload(prisma, viewer.oid, uploadId);
    await discardUpload(prisma, upload.id);
    return noContent();
  });
}
