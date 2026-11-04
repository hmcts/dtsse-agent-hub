import { HttpError, noContent } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { requireConversationOfAgent } from "@/assistant/conversation-store";
import { isPptx, KEEP_PPTX, MAX_PPTX_BYTES } from "@/assistant/deck";
import { versionParam } from "@/assistant/deck-build";
import { putDeckPptx } from "@/assistant/deck-store";
import { readBytes } from "@/assistant/upload-body";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The .pptx the pod built from one version of the conversation's deck. */
export const PUT = ownedAgentRoute<{ agentId: string; version: string }>(async ({ agent, request, params }) => {
  const version = versionParam(params.version);
  if (version === undefined) {
    throw new HttpError(400, "the version must be a whole number from 1");
  }
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const bytes = await readBytes(request, MAX_PPTX_BYTES).catch((error: unknown) => {
    throw error instanceof HttpError && error.status === 413 ? new HttpError(413, `a .pptx is at most ${MAX_PPTX_BYTES} bytes`) : error;
  });
  if (!isPptx(bytes)) {
    throw new HttpError(400, "that is not a .pptx");
  }
  const result = await putDeckPptx(prisma, conversation, version, bytes);
  if (result === "no_such_version") {
    throw new HttpError(404, "the deck has no such version");
  }
  if (result === "too_old") {
    throw new HttpError(409, `only the latest ${KEEP_PPTX} versions of a deck keep their .pptx`);
  }
  return noContent();
});
