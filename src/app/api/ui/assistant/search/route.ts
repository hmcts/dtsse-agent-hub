import type { NextRequest } from "next/server";
import { json } from "@/agent-api/http";
import { MAX_QUERY } from "@/assistant/search";
import { sidebarMatches } from "@/assistant/views";
import { prisma } from "@/store/prisma";
import { uiViewer } from "../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The chats, and the feedback projects by name, matching `?q=`, for the Assistant sidebar's search. Always the
 * signed-in person's own chats and the projects they are on the team of: the search takes its owner from the session
 * cookie rather than from the request, so there is nobody else's to ask for. A query with no word worth searching
 * for answers with nothing.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  const query = (request.nextUrl.searchParams.get("q") ?? "").slice(0, MAX_QUERY);
  return json({ results: await sidebarMatches(prisma, viewer.oid, query) });
}
