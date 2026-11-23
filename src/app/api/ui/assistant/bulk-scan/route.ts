import type { NextRequest } from "next/server";
import { errorResponse, json } from "@/agent-api/http";
import { readBytes } from "@/assistant/upload-body";
import { MAX_BULK_SCAN_FILE_BYTES, MAX_CASE_TYPE_ID, MAX_UPLOAD_BODY_BYTES, mebibytes } from "@/bulk-scan/limits";
import { importUpload, specName, uploadFileName } from "@/bulk-scan/spec";
import { createSpecs } from "@/bulk-scan/spec-store";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { uiRefusals, uiViewer } from "../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A form PDF, Exela SIP or transformation sheet, uploaded to start a spec, with the CCD case type id the person typed; one spec is made for each form the file holds. */
export async function POST(request: NextRequest): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (!virtualAgentsEnabled()) {
    return errorResponse(404, "the Bulk Scan form builder is not available on this deployment");
  }
  return await uiRefusals("bulk scan upload", async () => {
    const body = await readBytes(request, MAX_UPLOAD_BODY_BYTES);
    const form = await new Response(body, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData().catch(() => undefined);
    const file = form?.get("form");
    if (!(file instanceof File) || file.size > MAX_BULK_SCAN_FILE_BYTES) {
      return errorResponse(400, `choose a form PDF or an Excel spreadsheet (.pdf or .xlsx), up to ${mebibytes(MAX_BULK_SCAN_FILE_BYTES)}`);
    }
    const name = uploadFileName(file.name);
    if (name === null) {
      return errorResponse(400, "choose a form PDF or an Excel spreadsheet (.pdf or .xlsx)");
    }
    const typed = form?.get("caseType");
    const caseType = typeof typed === "string" ? typed.trim() : "";
    if (caseType.length > MAX_CASE_TYPE_ID) {
      return errorResponse(400, "the case type id is too long");
    }
    const imported = await importUpload(name, new Uint8Array(await file.arrayBuffer()), caseType || undefined);
    const fallback = name.replace(/\.(pdf|xlsx)$/i, "");
    const ids = await createSpecs(
      prisma,
      { actorOid: viewer.oid, ownerOid: viewer.oid },
      imported.forms.map((spec) => ({ name: specName(spec, fallback), spec }))
    );
    return json({ ids, kind: imported.kind }, 201);
  });
}
