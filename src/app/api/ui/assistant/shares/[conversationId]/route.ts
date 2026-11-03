import type { NextRequest } from "next/server";
import { errorResponse, json } from "@/agent-api/http";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { chatForks, chatShares } from "@/web/data";
import { uiRefusals, uiViewer } from "../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Who one of the signed-in person's own chats is shared with, or with `?mode=fork` offered to, for the settings'
 * Sharing section to show as a row is opened. Read on demand rather than with the rest of the settings, which every
 * Assistant page renders: it is a query per chat, for an editor most visits never open.
 *
 * Anybody else's chat is not found, as one that does not exist is: `chatShares` and `chatForks` apply
 * `canManageConversationShares`.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ conversationId: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (!virtualAgentsEnabled()) {
    return errorResponse(404, "the CFT Workspace is not available on this deployment");
  }
  return await uiRefusals("chat sharing read", async () => {
    const { conversationId } = await context.params;
    const fork = request.nextUrl.searchParams.get("mode") === "fork";
    const people = await (fork ? chatForks(viewer, conversationId) : chatShares(viewer, conversationId));
    return people === undefined ? errorResponse(404, "that chat is not there any more") : json({ people });
  });
}
