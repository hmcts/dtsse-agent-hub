import { HttpError, json, parseLimit, parseMessageId } from "@/agent-api/http";
import { agentRoute } from "@/agent-api/route";
import { MAX_FEED_LIMIT, topicMessages } from "@/messages/feed";
import { prisma } from "@/store/prisma";
import { normaliseSlug } from "@/topics/slug";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = agentRoute<{ slug: string }>(async ({ request, params }) => {
  const query = new URL(request.url).searchParams;
  const before = query.get("before");
  const since = query.get("since");
  if (before !== null && since !== null) {
    throw new HttpError(400, "send before or since, not both");
  }
  const messages = await topicMessages(prisma, {
    slug: normaliseSlug(params.slug),
    ...(before === null ? {} : { before: parseMessageId(before, "before") }),
    ...(since === null ? {} : { since: parseMessageId(since, "since") }),
    limit: parseLimit(query.get("limit"), MAX_FEED_LIMIT, MAX_FEED_LIMIT)
  });
  return json({ messages });
});
