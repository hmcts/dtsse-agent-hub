import type { NextRequest } from "next/server";
import { json } from "@/agent-api/http";
import { MAX_QUERY } from "@/assistant/search";
import { conversationMatches } from "@/assistant/views";
import { prisma } from "@/store/prisma";
import { uiViewer } from "../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The chats matching `?q=`, for the Assistant sidebar's search. Always the signed-in person's own and nobody else's:
 * the search takes its owner from the session cookie rather than from the request, so there is no other chat to ask
 * for. A query with no word worth searching for answers with nothing.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  const query = (request.nextUrl.searchParams.get("q") ?? "").slice(0, MAX_QUERY);
  return json({ chats: await conversationMatches(prisma, viewer.oid, query) });
}
