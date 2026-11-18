import { ownedAgentRoute } from "@/agent-api/route";
import { deckId, putPptx } from "@/assistant/deck-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The .pptx the pod built from one version of one deck. */
export const PUT = ownedAgentRoute<{ agentId: string; itemId: string; version: string }>(
  async ({ agent, request, params }) => await putPptx(agent, request, params.version, deckId(params.itemId))
);
