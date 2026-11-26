import type { NextRequest } from "next/server";
import { errorResponse, json } from "@/agent-api/http";
import { readBytes } from "@/assistant/upload-body";
import { isTranslationsJson, isXlsx, MAX_WELSH_FILE_BYTES, welshFileName } from "@/assistant/welsh";
import { saveUpload } from "@/assistant/welsh-store";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { uiRefusals, uiViewer } from "../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A file uploaded for one of the signed-in person's jobs to read: a spreadsheet the Welsh Language Unit sent back, or
 * earlier translations to set a service up from, which may also be a JSON copy.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (!virtualAgentsEnabled()) {
    return errorResponse(404, "Welsh translations are not available on this deployment");
  }
  return await uiRefusals("welsh upload", async () => {
    const name = welshFileName(request.headers.get("x-file-name"), { json: true });
    if (name === null) {
      return errorResponse(400, "choose an Excel spreadsheet (.xlsx) or a JSON file (.json)");
    }
    const bytes = await readBytes(request, MAX_WELSH_FILE_BYTES);
    if (/\.json$/i.test(name) ? !isTranslationsJson(bytes) : !isXlsx(bytes)) {
      return errorResponse(
        400,
        /\.json$/i.test(name)
          ? "that is not a JSON file of English to Welsh, with each Welsh a piece of text rather than more JSON"
          : "that is not an Excel spreadsheet (.xlsx)"
      );
    }
    return json({ file_id: await saveUpload(prisma, viewer.oid, name, bytes) }, 201);
  });
}
