import type { NextRequest } from "next/server";
import { errorResponse, json, readJson } from "@/agent-api/http";
import { findConversation } from "@/assistant/store";
import { createUpload } from "@/assistant/upload-store";
import { type UploadRefusal, uploadsEnabled } from "@/assistant/uploads";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { uiRefusals, uiViewer } from "../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Starts an upload for an Assistant conversation, answering the upload id and the part size to send it in.
 *
 * A route rather than a server action because the parts have to go to a route anyway (`src/web/action.ts` reads an
 * uploaded file as empty through the action envelope), and the composer is then written against URLs rather than
 * against an import of this module.
 *
 * Same-origin and authenticated by the `ah_session` cookie, like every other `/api/ui/*` route, so there is no upload
 * token and no CORS to get wrong.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (!virtualAgentsEnabled() || !uploadsEnabled()) {
    return errorResponse(404, "attaching files is not available on this deployment", { reason: "unavailable" satisfies UploadRefusal });
  }
  return await uiRefusals("start upload", async () => {
    const body = (await readJson(request)) as { conversationId?: unknown; name?: unknown; size?: unknown; mediaType?: unknown };
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
    const conversation = await findConversation(prisma, viewer.oid, conversationId);
    if (conversation === undefined) {
      return errorResponse(404, "that conversation no longer exists", { reason: "no_such_conversation" satisfies UploadRefusal });
    }
    const created = await createUpload(prisma, {
      conversationId: conversation.id,
      ownerOid: viewer.oid,
      name: body.name,
      size: body.size,
      mediaType: body.mediaType
    });
    return json(created, 201);
  });
}
