import { loadMessageRef, virtualAgentSessions } from "@/access/load";
import { canLaunchTokenReadMessage } from "@/access/rules";
import { HttpError, json, parse, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { directBody } from "@/agent-api/schemas";
import { directAsAgent } from "@/messages/send";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = ownedAgentRoute<{ agentId: string }>(async ({ caller, agent, request }) => {
  const body = parse(directBody, await readJson(request));
  const replyTo = body.reply_to_message;
  // A launch token replying to a message its sessions could not see is told it does not exist, as GET messages/{id}
  // tells it, rather than 403, which would confirm the owner's other agents were sent it.
  if (replyTo !== undefined && caller.virtualAgentId !== undefined) {
    const ref = await loadMessageRef(prisma, replyTo);
    if (ref !== undefined && !canLaunchTokenReadMessage(await virtualAgentSessions(prisma, caller.virtualAgentId), ref)) {
      throw new HttpError(404, "no such message");
    }
  }
  const message = await directAsAgent(prisma, agent, replyTo === undefined ? { toAgent: body.to_agent!, body: body.body } : { replyTo, body: body.body });
  return json({ message }, 201);
});
