import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { attachmentDisposition } from "@/assistant/downloads";
import { DEFAULT_JAVA_PACKAGE } from "@/bulk-scan/handoff";
import { loadSpec } from "@/bulk-scan/load";
import { codeDownload, type Download, isTarget, sipDownload, transformDownload, versionOf } from "@/bulk-scan/spec";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { uiRefusals, uiViewer } from "../../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `?kind=sip`, `?kind=transformation`, or `?kind=code&target=nfdiv[&package=…]`, of the latest version or `&version=n`. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (!virtualAgentsEnabled()) {
    return errorResponse(404, "the Bulk Scan form builder is not available on this deployment");
  }
  return await uiRefusals("bulk scan download", async () => {
    const { id } = await context.params;
    const query = request.nextUrl.searchParams;
    const { spec } = await loadSpec(prisma, { actorOid: viewer.oid, ownerOid: viewer.oid }, id, versionOf(query.get("version")));
    const kind = query.get("kind");
    let file: Download;
    if (kind === "sip") {
      file = await sipDownload(spec);
    } else if (kind === "transformation") {
      file = await transformDownload(spec);
    } else if (kind === "code") {
      const target = query.get("target");
      if (!isTarget(target)) {
        return errorResponse(400, "choose what to generate code for");
      }
      file = codeDownload(spec, target, query.get("package")?.trim() || DEFAULT_JAVA_PACKAGE);
    } else {
      return errorResponse(400, "choose sip, transformation or code");
    }
    return new Response(Buffer.from(file.bytes), {
      headers: {
        "content-type": file.contentType,
        "content-length": String(file.bytes.length),
        "x-content-type-options": "nosniff",
        "content-disposition": attachmentDisposition(file.fileName),
        "cache-control": "no-store"
      }
    });
  });
}
