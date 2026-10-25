import { HttpError } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { conversationOfAgent } from "@/assistant/store";
import { readUploadPart, sessionAttachment } from "@/assistant/upload-store";
import { partIndexOf, uploadsEnabled } from "@/assistant/uploads";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One part of a file attached to a message in this agent's conversation, as raw bytes. The pod pulls the parts in
 * turn and appends each to the file on its disk, so neither end holds the whole file.
 *
 * The hub makes no outbound HTTP of its own, so every pod↔hub call goes this way round; that is what made a relay
 * through Postgres the transport rather than a proxy to the pod.
 */
export const GET = ownedAgentRoute<{ agentId: string; uploadId: string; index: string }>(async ({ agent, params }) => {
  if (!virtualAgentsEnabled() || !uploadsEnabled()) {
    throw new HttpError(404, "not found");
  }
  const conversation = await conversationOfAgent(prisma, agent.id);
  const upload = await sessionAttachment(prisma, conversation?.id ?? null, params.uploadId, "part");
  const index = partIndexOf(params.index, upload.bytes);
  const data = index === undefined ? undefined : await readUploadPart(prisma, upload.id, index);
  if (data === undefined) {
    throw new HttpError(404, "no such part of this file");
  }
  return new Response(data, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(data.byteLength),
      // The bytes are deleted as soon as the pod says it has them, so nothing between here and there may keep a copy.
      "cache-control": "no-store"
    }
  });
});
