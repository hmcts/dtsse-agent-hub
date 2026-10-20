import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { isUuid } from "@/agents/store";
import { portOf } from "@/port-viewer/paths";
import { ticketUrl } from "@/port-viewer/serve";
import { viewerSettings } from "@/port-viewer/settings";
import { prisma } from "@/store/prisma";
import { currentViewer } from "@/viewer/current";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { findVirtualAgent } from "@/virtual-agents/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Hands a signed-in owner a ticket to open one of their virtual agent's web servers on the viewer's host. The proxy
 * has already signed the person in. Anything that is not theirs to open is answered as not found.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; port: string }> }): Promise<Response> {
  const settings = viewerSettings();
  const { id, port: rawPort } = await params;
  const port = portOf(rawPort);
  if (!virtualAgentsEnabled() || settings === undefined || port === undefined || !isUuid(id)) {
    return errorResponse(404, "not found");
  }
  const viewer = await currentViewer();
  if (viewer === undefined) {
    return errorResponse(401, "sign in first");
  }
  const url = await ticketUrl(viewer.oid, await findVirtualAgent(prisma, id.toLowerCase()), port, request.nextUrl.searchParams.get("path"), settings);
  if (url === undefined) {
    return errorResponse(404, "not found");
  }
  return new Response(null, { status: 303, headers: { location: url, "cache-control": "no-store" } });
}
