import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { serveViewer } from "@/port-viewer/serve";
import { VIEWER_URL_HEADER, viewerSettings } from "@/port-viewer/settings";
import { prisma } from "@/store/prisma";
import { publicDomain, virtualAgentsEnabled } from "@/virtual-agents/settings";
import { findVirtualAgent } from "@/virtual-agents/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every request to the viewer's host, which the proxy rewrites here with the original path and query in
 * `VIEWER_URL_HEADER`. The proxy answers this path with 404 on every other host, so the header is always its own.
 */
async function handle(request: NextRequest): Promise<Response> {
  const settings = viewerSettings();
  const pathAndQuery = request.headers.get(VIEWER_URL_HEADER);
  if (!virtualAgentsEnabled() || settings === undefined || pathAndQuery === null) {
    return errorResponse(404, "not found");
  }
  return await serveViewer(request, pathAndQuery, {
    settings,
    publicDomain: publicDomain(),
    loadAgent: (id) => findVirtualAgent(prisma, id),
    fetch: (input, init) => fetch(input, init)
  });
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
