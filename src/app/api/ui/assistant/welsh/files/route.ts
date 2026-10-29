import type { NextRequest } from "next/server";
import { errorResponse, json } from "@/agent-api/http";
import { readBytes } from "@/assistant/upload-body";
import { isXlsx, MAX_WELSH_FILE_BYTES, welshFileName } from "@/assistant/welsh";
import { saveUpload } from "@/assistant/welsh-store";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { uiRefusals, uiViewer } from "../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A spreadsheet the Welsh Language Unit sent back, uploaded for one of the signed-in person's jobs to read. */
export async function POST(request: NextRequest): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (!virtualAgentsEnabled()) {
    return errorResponse(404, "Welsh translations are not available on this deployment");
  }
  return await uiRefusals("welsh upload", async () => {
    const name = welshFileName(request.headers.get("x-file-name"));
    if (name === null) {
      return errorResponse(400, "choose an Excel spreadsheet (.xlsx)");
    }
    const bytes = await readBytes(request, MAX_WELSH_FILE_BYTES);
    if (!isXlsx(bytes)) {
      return errorResponse(400, "that is not an Excel spreadsheet (.xlsx)");
    }
    return json({ file_id: await saveUpload(prisma, viewer.oid, name, bytes) }, 201);
  });
}
