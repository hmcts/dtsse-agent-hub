import { grantsHeldBy, loadMessageRef, virtualAgentSessions } from "@/access/load";
import { canLaunchTokenReadMessage, canReadMessage } from "@/access/rules";
import { HttpError, json, parseMessageId } from "@/agent-api/http";
import { agentRoute } from "@/agent-api/route";
import { loadMessage } from "@/messages/store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A launch token reads as its virtual agent's sessions, not as their owner: a message they could not see is answered
 * 404, the same as one that does not exist, so the token cannot learn what the owner's other agents were sent.
 */
export const GET = agentRoute<{ id: string }>(async ({ caller, params }) => {
  const id = parseMessageId(params.id);
  const ref = await loadMessageRef(prisma, id);
  if (ref === undefined) {
    throw new HttpError(404, "no such message");
  }
  if (caller.virtualAgentId !== undefined && !canLaunchTokenReadMessage(await virtualAgentSessions(prisma, caller.virtualAgentId), ref)) {
    throw new HttpError(404, "no such message");
  }
  if (!canReadMessage(caller.oid, ref, await grantsHeldBy(prisma, caller.oid))) {
    throw new HttpError(403, "you may not read that message");
  }
  return json({ message: await loadMessage(prisma, id) });
});
