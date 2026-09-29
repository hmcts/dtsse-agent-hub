import { json, parse, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { directBody } from "@/agent-api/schemas";
import { directAsAgent } from "@/messages/send";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const body = parse(directBody, await readJson(request));
  const message = await directAsAgent(
    prisma,
    agent,
    body.reply_to_message === undefined ? { toAgent: body.to_agent!, body: body.body } : { replyTo: body.reply_to_message, body: body.body }
  );
  return json({ message }, 201);
});
