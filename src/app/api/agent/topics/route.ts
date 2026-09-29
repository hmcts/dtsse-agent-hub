import { json, parseLimit } from "@/agent-api/http";
import { agentRoute } from "@/agent-api/route";
import { prisma } from "@/store/prisma";
import { DEFAULT_TOPIC_LIMIT, listTopics, MAX_TOPIC_LIMIT } from "@/topics/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = agentRoute(async ({ request }) => {
  const query = new URL(request.url).searchParams;
  const prefix = (query.get("prefix") ?? "").trim().toLowerCase();
  const limit = parseLimit(query.get("limit"), DEFAULT_TOPIC_LIMIT, MAX_TOPIC_LIMIT);
  return json({ topics: await listTopics(prisma, prefix, limit) });
});
