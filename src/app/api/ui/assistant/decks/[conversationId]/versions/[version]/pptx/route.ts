import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { versionParam } from "@/assistant/deck-build";
import { requestDeckBuild } from "@/assistant/deck-build-store";
import { attachmentDisposition, fileName } from "@/assistant/downloads";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { deckPptx } from "@/web/data";
import { uiRefusals, uiViewer } from "../../../../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** One version of a conversation's deck as the .pptx its session built, to download, under the same rule as its pictures. */
export async function GET(request: NextRequest, context: { params: Promise<{ conversationId: string; version: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  return await uiRefusals("deck download", async () => {
    const { conversationId, version } = await context.params;
    const file = /^[1-9]\d{0,8}$/.test(version) ? await deckPptx(viewer, conversationId, Number(version)) : undefined;
    if (file === undefined) {
      return errorResponse(404, "that version of the slides has no .pptx");
    }
    return new Response(Buffer.from(file.bytes), {
      headers: {
        "content-type": PPTX,
        "content-length": String(file.bytes.length),
        "x-content-type-options": "nosniff",
        "content-disposition": attachmentDisposition(fileName(file.title, "pptx")),
        "cache-control": "no-store"
      }
    });
  });
}

/**
 * Asks the conversation's pod to build this version's .pptx, for its owner alone, and answers `ready` when the hub
 * already holds one. The page reads a build back through `…/builds/{job_id}`. See "Deck builds" in docs/agent-api.md.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ conversationId: string; version: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (!virtualAgentsEnabled()) {
    return errorResponse(404, "building slides is not available on this deployment");
  }
  return await uiRefusals("deck build", async () => {
    const { conversationId, version } = await context.params;
    const number = versionParam(version);
    if (number === undefined) {
      return errorResponse(404, "that version of the slides is not there");
    }
    return Response.json(await requestDeckBuild(prisma, viewer.oid, conversationId, number), { headers: { "cache-control": "no-store" } });
  });
}
