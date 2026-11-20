import type { NextRequest } from "next/server";
import { errorResponse, json } from "@/agent-api/http";
import { readBytes } from "@/assistant/upload-body";
import { importUpload, MAX_BULK_SCAN_FILE_BYTES, specName, uploadFileName } from "@/bulk-scan/spec";
import { createSpecs } from "@/bulk-scan/spec-store";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { uiRefusals, uiViewer } from "../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A form PDF, Exela SIP or transformation sheet, uploaded to start a spec; one spec is made for each form the file holds. */
export async function POST(request: NextRequest): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (!virtualAgentsEnabled()) {
    return errorResponse(404, "the Bulk Scan form builder is not available on this deployment");
  }
  return await uiRefusals("bulk scan upload", async () => {
    const name = uploadFileName(request.headers.get("x-file-name"));
    if (name === null) {
      return errorResponse(400, "choose a form PDF or an Excel spreadsheet (.pdf or .xlsx)");
    }
    const imported = await importUpload(name, await readBytes(request, MAX_BULK_SCAN_FILE_BYTES));
    const fallback = name.replace(/\.(pdf|xlsx)$/i, "");
    const ids = await createSpecs(
      prisma,
      { actorOid: viewer.oid, ownerOid: viewer.oid },
      imported.forms.map((spec) => ({ name: specName(spec, fallback), spec }))
    );
    return json({ ids, kind: imported.kind }, 201);
  });
}
