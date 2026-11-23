import type { NextRequest } from "next/server";
import { errorResponse, json } from "@/agent-api/http";
import { readBytes } from "@/assistant/upload-body";
import {
  type CcdUpload,
  importUpload,
  MAX_BULK_SCAN_FILE_BYTES,
  MAX_CASE_TYPE_ID,
  MAX_CCD_DEFINITION_BYTES,
  parseCcdFields,
  specName,
  uploadFileName
} from "@/bulk-scan/spec";
import { createSpecs } from "@/bulk-scan/spec-store";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { uiRefusals, uiViewer } from "../../request";

/** What the multipart framing of the form, the definition and the case type may add to the two files. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A form PDF, Exela SIP or transformation sheet, uploaded to start a spec, with the case type's CCD definition for a PDF; one spec is made for each form the file holds. */
export async function POST(request: NextRequest): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (!virtualAgentsEnabled()) {
    return errorResponse(404, "the Bulk Scan form builder is not available on this deployment");
  }
  return await uiRefusals("bulk scan upload", async () => {
    const body = await readBytes(request, MAX_BULK_SCAN_FILE_BYTES + MAX_CCD_DEFINITION_BYTES + MULTIPART_OVERHEAD_BYTES);
    const form = await new Response(body, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData().catch(() => undefined);
    const file = form?.get("form");
    if (!(file instanceof File) || file.size > MAX_BULK_SCAN_FILE_BYTES) {
      return errorResponse(400, "choose a form PDF or an Excel spreadsheet (.pdf or .xlsx), up to 5 MiB");
    }
    const name = uploadFileName(file.name);
    if (name === null) {
      return errorResponse(400, "choose a form PDF or an Excel spreadsheet (.pdf or .xlsx)");
    }
    const definition = form?.get("definition");
    const typed = form?.get("caseType");
    if (definition instanceof File && definition.size > MAX_CCD_DEFINITION_BYTES) {
      return errorResponse(400, "the CCD definition is over 1 MiB: give the case type's own CaseField.json or its folder zipped");
    }
    const caseType = typeof typed === "string" ? typed.trim() : "";
    if (caseType.length > MAX_CASE_TYPE_ID) {
      return errorResponse(400, "the case type id is too long");
    }
    const bytes = definition instanceof File && definition.size > 0 ? new Uint8Array(await definition.arrayBuffer()) : undefined;
    const picked = pickedCaseType(form?.get("product"), form?.get("config"), form?.get("fields"));
    if (picked instanceof Response) {
      return picked;
    }
    const ccd: CcdUpload | undefined =
      bytes || caseType || picked ? { ...(bytes ? { bytes } : {}), ...(caseType ? { caseType } : {}), ...(picked ? { picked } : {}) } : undefined;
    const imported = await importUpload(name, new Uint8Array(await file.arrayBuffer()), ccd);
    const fallback = name.replace(/\.(pdf|xlsx)$/i, "");
    const ids = await createSpecs(
      prisma,
      { actorOid: viewer.oid, ownerOid: viewer.oid },
      imported.forms.map((spec) => ({ name: specName(spec, fallback), spec }))
    );
    return json({ ids, kind: imported.kind }, 201);
  });
}

const CONFIGS = ["config-generator", "json", "hybrid"] as const;

/** The case type the person picked, with the fields their pod fetched for it; none when no fields came, and a refusal when they are not what the job answers. */
function pickedCaseType(product: unknown, config: unknown, fields: unknown): NonNullable<CcdUpload["picked"]> | Response | undefined {
  if (typeof fields !== "string" || fields === "") {
    return undefined;
  }
  if (fields.length > MAX_CCD_DEFINITION_BYTES) {
    return errorResponse(400, "the case type's fields are over 1 MiB");
  }
  if (typeof product !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(product)) {
    return errorResponse(400, "name the product that defines the case type");
  }
  let rows: unknown;
  try {
    rows = JSON.parse(fields);
  } catch {
    return errorResponse(400, "the case type's fields are not JSON");
  }
  const found = CONFIGS.find((c) => c === config);
  return { product, ...(found ? { config: found } : {}), fields: parseCcdFields(rows) };
}
