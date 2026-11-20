import type { NextRequest } from "next/server";
import { errorResponse, json } from "@/agent-api/http";
import { readBytes } from "@/assistant/upload-body";
import { checkSpec, MAX_SPEC_BYTES, specName } from "@/bulk-scan/spec";
import { saveVersion } from "@/bulk-scan/spec-store";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { uiRefusals, uiViewer } from "../../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Saves the edited spec as the next version of the one it started from, or answers every place it fails the schema so the editor can mark each one. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (!virtualAgentsEnabled()) {
    return errorResponse(404, "the Bulk Scan form builder is not available on this deployment");
  }
  return await uiRefusals("bulk scan save", async () => {
    const { id } = await context.params;
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(await readBytes(request, MAX_SPEC_BYTES)));
    } catch (error) {
      if (error instanceof SyntaxError) {
        return errorResponse(400, "the request body is not valid JSON");
      }
      throw error;
    }
    const body = raw as { baseVersion?: unknown; spec?: unknown } | null;
    if (typeof body !== "object" || body === null || typeof body.baseVersion !== "number" || !Number.isInteger(body.baseVersion) || body.spec === undefined) {
      return errorResponse(400, "send the spec and the version the edit started from");
    }
    const checked = checkSpec(body.spec);
    if (!checked.ok) {
      return errorResponse(422, "the spec has errors", { issues: checked.issues });
    }
    const version = await saveVersion(prisma, { actorOid: viewer.oid, ownerOid: viewer.oid }, id, body.baseVersion, {
      name: specName(checked.spec, "Untitled form"),
      spec: checked.spec
    });
    return json({ version }, 201);
  });
}
