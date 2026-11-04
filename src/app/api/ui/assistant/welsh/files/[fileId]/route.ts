import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { attachmentDisposition } from "@/assistant/downloads";
import { ownerFile } from "@/assistant/welsh-store";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { uiRefusals, uiViewer } from "../../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** One of the signed-in person's own Welsh spreadsheets: one they uploaded, or one their jobs made. Nobody else's. */
export async function GET(request: NextRequest, context: { params: Promise<{ fileId: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (!virtualAgentsEnabled()) {
    return errorResponse(404, "Welsh translations are not available on this deployment");
  }
  return await uiRefusals("welsh download", async () => {
    const { fileId } = await context.params;
    const file = await ownerFile(prisma, viewer.oid, fileId);
    if (file === undefined) {
      return errorResponse(404, "that spreadsheet is not there any more");
    }
    return new Response(Buffer.from(file.bytes), {
      headers: {
        "content-type": XLSX,
        "content-length": String(file.bytes.length),
        "x-content-type-options": "nosniff",
        "content-disposition": attachmentDisposition(file.name),
        "cache-control": "no-store"
      }
    });
  });
}
