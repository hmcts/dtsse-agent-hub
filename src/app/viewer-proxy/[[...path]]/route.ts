import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { feedbackEnabled } from "@/feedback/settings";
import { findLink } from "@/feedback/store";
import { cachedPublicAddresses, pinnedFetch } from "@/feedback/targets";
import { denyFraming, serveViewer } from "@/port-viewer/serve";
import { VIEWER_URL_HEADER, viewerSettings } from "@/port-viewer/settings";
import { readWidget } from "@/port-viewer/widget";
import { prisma } from "@/store/prisma";
import { publicDomain, virtualAgentsEnabled } from "@/virtual-agents/settings";
import { findVirtualAgent } from "@/virtual-agents/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One per server process, so a prototype's page and its assets share one lookup of its host, which both the check
 * before each fetch and every connection the fetch makes are answered from.
 */
const publicAddresses = cachedPublicAddresses();

const feedbackFetch = pinnedFetch(publicAddresses);

/**
 * Every request to the viewer's host, which the proxy rewrites here with the original path and query in
 * `VIEWER_URL_HEADER`. The proxy answers this path with 404 on every other host, so the header is always its own.
 * Agents' ports are served while virtual agents are on, and feedback links while feedback is; with neither on, the
 * viewer serves nothing.
 */
async function handle(request: NextRequest): Promise<Response> {
  const settings = viewerSettings();
  const pathAndQuery = request.headers.get(VIEWER_URL_HEADER);
  const ports = virtualAgentsEnabled();
  const feedback = feedbackEnabled();
  if ((!ports && !feedback) || settings === undefined || pathAndQuery === null) {
    return denyFraming(errorResponse(404, "not found"));
  }
  return await serveViewer(request, pathAndQuery, {
    settings,
    publicDomain: publicDomain(),
    loadAgent: ports ? (id) => findVirtualAgent(prisma, id) : async () => undefined,
    fetch: (input, init) => fetch(input, init),
    feedback: feedback ? { findLink: (token) => findLink(prisma, token), publicAddresses, fetch: feedbackFetch, readWidget: () => readWidget() } : undefined
  });
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
