import { grantsHeldBy, loadMessageRef } from "@/access/load";
import { canReadMessage } from "@/access/rules";
import { HttpError, json, parseMessageId } from "@/agent-api/http";
import { agentRoute } from "@/agent-api/route";
import { loadMessage } from "@/messages/store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = agentRoute<{ id: string }>(async ({ caller, params }) => {
  const id = parseMessageId(params.id);
  const ref = await loadMessageRef(prisma, id);
  if (ref === undefined) {
    throw new HttpError(404, "no such message");
  }
  if (!canReadMessage(caller.oid, ref, await grantsHeldBy(prisma, caller.oid))) {
    throw new HttpError(403, "you may not read that message");
  }
  return json({ message: await loadMessage(prisma, id) });
});
