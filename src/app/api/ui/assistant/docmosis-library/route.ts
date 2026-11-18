import type { NextRequest } from "next/server";
import { errorResponse, readJson } from "@/agent-api/http";
import { openLibrary } from "@/assistant/docmosis-library-store";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { uiRefusals, uiViewer } from "../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The signed-in person's template library: what the hub holds of its index, asking their own pod to check GitHub when
 * a check is due or `force` asks for one. Answers at once; the pod's answer reaches the page as an
 * `assistant_docmosis_library` frame. See "Docmosis template library" in docs/agent-api.md.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (!virtualAgentsEnabled()) {
    return errorResponse(404, "the template library is not available on this deployment");
  }
  return await uiRefusals("template library", async () => {
    const body = await readJson(request);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return errorResponse(400, "the request body must be a JSON object");
    }
    const { force } = body as { force?: unknown };
    if (force !== undefined && typeof force !== "boolean") {
      return errorResponse(400, "force must be true or false");
    }
    const status = await openLibrary(prisma, viewer.oid, { force: force === true });
    return Response.json(status, { headers: { "Cache-Control": "no-store" } });
  });
}
