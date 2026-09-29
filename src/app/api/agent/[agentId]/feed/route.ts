import { json, parseLimit, parseMessageId } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { readCursor } from "@/agents/store";
import { agentFeed, MAX_FEED_LIMIT } from "@/messages/feed";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const query = new URL(request.url).searchParams;
  const since = query.get("since");
  const after = since === null || since === "" ? await readCursor(prisma, agent.id) : parseMessageId(since, "since");
  const limit = parseLimit(query.get("limit"), MAX_FEED_LIMIT, MAX_FEED_LIMIT);
  return json(await agentFeed(prisma, agent.id, after, limit));
});
