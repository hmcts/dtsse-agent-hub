import type { NextRequest } from "next/server";
import { errorResponse, HttpError, json, parseMessageId } from "@/agent-api/http";
import { parseMatch, viewTopics } from "@/channels/rules";
import { channelFeed } from "@/messages/feed";
import { FEED_PAGE_SIZE, toPage } from "@/messages/pagination";
import { prisma } from "@/store/prisma";
import { uiViewer } from "../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One page of a channel view, for "load older": `?topics=a,b&mode=any|all&before=<id>`. */
export async function GET(request: NextRequest): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  const query = request.nextUrl.searchParams;
  const { topics, invalid } = viewTopics(query.getAll("topics"));
  if (invalid.length > 0) {
    return errorResponse(400, `not topics: ${invalid.join(", ")}`);
  }
  let before: bigint | undefined;
  try {
    const raw = query.get("before");
    before = raw === null ? undefined : parseMessageId(raw, "before");
  } catch (error) {
    return errorResponse(400, error instanceof HttpError ? error.message : "bad request");
  }
  const rows = await channelFeed(prisma, {
    topics,
    match: parseMatch(query.get("mode")),
    ...(before === undefined ? {} : { before }),
    limit: FEED_PAGE_SIZE + 1
  });
  return json(toPage(rows));
}
