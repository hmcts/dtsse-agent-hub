import { ownedAgentRoute } from "@/agent-api/route";
import { putTemplatePdf } from "@/assistant/docmosis-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The PDF the pod rendered from one version of the conversation's primary template. */
export const PUT = ownedAgentRoute<{ agentId: string; version: string }>(
  async ({ agent, request, params }) => await putTemplatePdf(agent, request, params.version)
);
