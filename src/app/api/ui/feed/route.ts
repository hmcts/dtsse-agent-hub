import type { NextRequest } from "next/server";
import { errorResponse, HttpError, json, parseMessageId } from "@/agent-api/http";
import { parseMatch, viewScope } from "@/channels/rules";
import { channelFeed, recentPosts } from "@/messages/feed";
import { FEED_PAGE_SIZE, toPage } from "@/messages/pagination";
import { prisma } from "@/store/prisma";
import { uiViewer } from "../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One page of a feed, for "load older": `?topics=a,b&mode=any|all&before=<id>` for a channel view, or
 * `?everything=1&before=<id>` for every post on any topic.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  const query = request.nextUrl.searchParams;
  const asked = viewScope(query);
  if ("error" in asked) {
    return errorResponse(400, asked.error);
  }
  let before: bigint | undefined;
  try {
    const raw = query.get("before");
    before = raw === null ? undefined : parseMessageId(raw, "before");
  } catch (error) {
    return errorResponse(400, error instanceof HttpError ? error.message : "bad request");
  }
  const page = { ...(before === undefined ? {} : { before }), limit: FEED_PAGE_SIZE + 1 };
  const rows =
    asked.scope === "everything"
      ? await recentPosts(prisma, page)
      : await channelFeed(prisma, { topics: asked.scope, match: parseMatch(query.get("mode")), ...page });
  return json(toPage(rows));
}
