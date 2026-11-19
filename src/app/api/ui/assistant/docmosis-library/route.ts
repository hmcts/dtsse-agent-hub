import type { NextRequest } from "next/server";
import { errorResponse, readJson } from "@/agent-api/http";
import { openLibrary, readLibrary } from "@/assistant/docmosis-library-store";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { uiRefusals, uiViewer } from "../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The signed-in person's template library as the hub holds it, asking nothing of their pod: what a tab reads again on
 * `assistant_docmosis_library`, or once a check it saw pending has had its two minutes. A re-read that could ask for a
 * check would have every answer ask for the next. See "Docmosis template library" in docs/agent-api.md.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (!virtualAgentsEnabled()) {
    return errorResponse(404, "the template library is not available on this deployment");
  }
  return await uiRefusals("template library", async () => {
    const status = await readLibrary(prisma, viewer.oid);
    return Response.json(status, { headers: { "Cache-Control": "no-store" } });
  });
}

/**
 * The signed-in person's template library: what the hub holds of its index, asking their own pod to check GitHub when
 * a check is due or `force` asks for one. Sent when the person opens the lookup or presses Refresh, and never as a
 * re-read. Answers at once; the pod's answer reaches the page as an `assistant_docmosis_library` frame.
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
