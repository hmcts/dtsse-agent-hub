import type { NextRequest } from "next/server";
import { canChangeNotify } from "@/access/rules";
import { errorResponse, parse, readJson } from "@/agent-api/http";
import { notifySaveBody } from "@/assistant/notify";
import { writeUserNotify } from "@/assistant/notify-store";
import { prisma } from "@/store/prisma";
import { notifyAccess } from "@/web/data";
import { uiRefusals, uiViewer } from "../../../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Saves the owner's draft and personalisation as their version of one of the conversation's Notify templates: an amend of their
 * own latest version, or the next version. `409 {error, current}` when the base is no longer the template's.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ conversationId: string; itemId: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  return await uiRefusals("notify save", async () => {
    const { conversationId, itemId } = await context.params;
    const access = await notifyAccess(viewer, conversationId, itemId);
    if (access === undefined) {
      return errorResponse(404, "that chat has no Notify template you can change");
    }
    if (!canChangeNotify(access)) {
      return errorResponse(403, "only the owner of a chat can change its Notify template");
    }
    const body = parse(notifySaveBody, await readJson(request));
    const saved = await writeUserNotify(prisma, {
      conversationId,
      itemId,
      editorOid: viewer.oid,
      subject: body.subject,
      body: body.body,
      data: body.data,
      baseVersion: body.base_version,
      baseRevision: body.base_revision
    });
    return Response.json(saved, { headers: { "cache-control": "no-store" } });
  });
}
