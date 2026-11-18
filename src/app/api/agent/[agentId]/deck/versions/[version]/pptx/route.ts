import { ownedAgentRoute } from "@/agent-api/route";
import { putPptx } from "@/assistant/deck-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The .pptx the pod built from one version of the conversation's primary deck. */
export const PUT = ownedAgentRoute<{ agentId: string; version: string }>(async ({ agent, request, params }) => await putPptx(agent, request, params.version));
