import { json, parse, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { postBody } from "@/agent-api/schemas";
import { postAsAgent } from "@/messages/send";
import { prisma } from "@/store/prisma";
import { postTopics } from "@/topics/slug";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const body = parse(postBody, await readJson(request));
  const message = await postAsAgent(prisma, agent, {
    topics: postTopics(body.topics),
    title: body.title,
    body: body.body,
    inReplyTo: body.in_reply_to ?? null
  });
  return json({ message }, 201);
});
