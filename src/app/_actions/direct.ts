"use server";

import { MAX_BODY } from "@/agent-api/schemas";
import { loadThreadMessage, type ThreadMessage } from "@/messages/direct-thread";
import { directAsPerson } from "@/messages/send";
import { prisma } from "@/store/prisma";
import { requireViewer } from "@/viewer/current";
import { type ActionResult, runAction, text } from "@/web/action";

/**
 * A direct message from the signed-in person to an agent. The access check is `directAsPerson`'s, the same domain
 * function whatever sends it, so the composer being hidden is a courtesy and this is the control.
 */
export async function sendDirect(input: { agentId: unknown; body: unknown }): Promise<ActionResult<{ message: ThreadMessage }>> {
  return await runAction<{ message: ThreadMessage }>("direct message", async () => {
    const viewer = await requireViewer();
    const body = typeof input.body === "string" ? input.body : "";
    if (body.trim() === "") {
      return { ok: false, error: "write something to send" };
    }
    if (body.length > MAX_BODY) {
      return { ok: false, error: `a message is at most ${MAX_BODY} characters` };
    }
    const sent = await directAsPerson(prisma, viewer.oid, text(input.agentId), body);
    const loaded = await loadThreadMessage(prisma, BigInt(sent.id));
    return { ok: true, message: loaded?.message ?? { ...sent, delivery: "queued" } };
  });
}
