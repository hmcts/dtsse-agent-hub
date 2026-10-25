import { HttpError, noContent } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { conversationOfAgent } from "@/assistant/store";
import { reportFetched, sessionAttachment } from "@/assistant/upload-store";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The pod has the whole file on its disk. This is what deletes the part rows, so it is the one thing standing between
 * this transport and a database that grows by 25 MB an upload; the sweep in `src/assistant/upload-sweep.ts` is the
 * backstop for when it does not arrive.
 *
 * Idempotent, because a pod that lost the response has no way to tell a stored upload from a fetched one and would
 * otherwise be stuck retrying a refusal.
 */
export const POST = ownedAgentRoute<{ agentId: string; uploadId: string }>(async ({ agent, params }) => {
  if (!virtualAgentsEnabled()) {
    throw new HttpError(404, "not found");
  }
  const conversation = await conversationOfAgent(prisma, agent.id);
  const upload = await sessionAttachment(prisma, conversation?.id ?? null, params.uploadId, "fetched");
  await reportFetched(prisma, upload.id);
  return noContent();
});
