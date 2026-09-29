import { json, parse, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { topicsBody } from "@/agent-api/schemas";
import { prisma } from "@/store/prisma";
import { normaliseSlugs } from "@/topics/slug";
import { subscribe, subscriptions, unsubscribe } from "@/topics/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = ownedAgentRoute<{ agentId: string }>(async ({ agent }) => json({ topics: await subscriptions(prisma, agent.id) }));

export const PUT = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const topics = normaliseSlugs(parse(topicsBody, await readJson(request)).topics);
  return json({ topics: await subscribe(prisma, agent.id, topics) });
});

export const DELETE = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const topics = normaliseSlugs(parse(topicsBody, await readJson(request)).topics);
  return json({ topics: await unsubscribe(prisma, agent.id, topics) });
});
