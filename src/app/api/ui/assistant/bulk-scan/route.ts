import { CCD_CONFIGS, REPO_PATH } from "@hmcts-cft/bulk-scan-spec/schema";
import type { NextRequest } from "next/server";
import { errorResponse, json } from "@/agent-api/http";
import { MAX_FIELDS_BYTES, PRODUCT } from "@/assistant/ccd-jobs";
import { readBytes } from "@/assistant/upload-body";
import { describeBytes } from "@/assistant/uploads";
import { MAX_BULK_SCAN_FILE_BYTES, MAX_CASE_TYPE_ID, MAX_UPLOAD_BODY_BYTES } from "@/bulk-scan/limits";
import { importUpload, parseCcdFields, specName, type UploadedCaseType, uploadFileName } from "@/bulk-scan/spec";
import { createSpecs } from "@/bulk-scan/spec-store";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { uiRefusals, uiViewer } from "../../request";

/** What the picked case type's fields may weigh in the body: the pod cuts its answer to `MAX_FIELDS_BYTES`, and the browser sends the same JSON back. */
const MAX_PICKED_FIELDS_BYTES = MAX_FIELDS_BYTES + 64 * 1024;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The multipart body read once, up to the cap, and parsed; the buffer it was read into is not kept, so the upload is held as the parsed file and nothing else. */
async function parseForm(request: NextRequest): Promise<FormData | undefined> {
  const body = await readBytes(request, MAX_UPLOAD_BODY_BYTES + MAX_PICKED_FIELDS_BYTES);
  return await new Response(body, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData().catch(() => undefined);
}

/** A form PDF, Exela SIP or transformation sheet, uploaded to start a spec, with the CCD case type the person picked (its id, product and fields) or typed (its id alone); one spec is made for each form the file holds. */
export async function POST(request: NextRequest): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (!virtualAgentsEnabled()) {
    return errorResponse(404, "the Bulk Scan form builder is not available on this deployment");
  }
  return await uiRefusals("bulk scan upload", async () => {
    const form = await parseForm(request);
    const file = form?.get("form");
    if (!(file instanceof File) || file.size > MAX_BULK_SCAN_FILE_BYTES) {
      return errorResponse(400, `choose a form PDF or an Excel spreadsheet (.pdf or .xlsx), up to ${describeBytes(MAX_BULK_SCAN_FILE_BYTES)}`);
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
    const picked = pickedCaseType(caseType, form?.get("product"), form?.get("config"), form?.get("repo"), form?.get("fields"));
    if (picked instanceof Response) {
      return picked;
    }
    const imported = await importUpload(name, new Uint8Array(await file.arrayBuffer()), picked);
    const fallback = name.replace(/\.(pdf|xlsx)$/i, "");
    const ids = await createSpecs(
      prisma,
      { actorOid: viewer.oid, ownerOid: viewer.oid },
      imported.forms.map((spec) => ({ name: specName(spec, fallback), spec }))
    );
    return json({ ids, kind: imported.kind }, 201);
  });
}

/** The case type the person picked, with the fields their pod fetched for it; none when no fields came, and a refusal when they are not what the job answers. */
function pickedCaseType(caseType: string, product: unknown, config: unknown, repo: unknown, fields: unknown): UploadedCaseType | Response | undefined {
  if (typeof fields !== "string" || fields === "") {
    return undefined;
  }
  if (Buffer.byteLength(fields, "utf8") > MAX_PICKED_FIELDS_BYTES) {
    return errorResponse(400, "the case type's fields are too large");
  }
  if (caseType === "") {
    return errorResponse(400, "name the case type the fields belong to");
  }
  if (typeof product !== "string" || !PRODUCT.test(product)) {
    return errorResponse(400, "name the product that defines the case type");
  }
  let rows: unknown;
  try {
    rows = JSON.parse(fields);
  } catch {
    return errorResponse(400, "the case type's fields are not JSON");
  }
  const found = CCD_CONFIGS.find((c) => c === config);
  return {
    caseType,
    product,
    ...(found ? { config: found } : {}),
    ...(typeof repo === "string" && REPO_PATH.test(repo) ? { repo } : {}),
    fields: parseCcdFields(rows)
  };
}
