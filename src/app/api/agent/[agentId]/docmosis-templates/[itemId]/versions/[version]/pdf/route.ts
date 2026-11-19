import { ownedAgentRoute } from "@/agent-api/route";
import { putTemplatePdf, templateId } from "@/assistant/docmosis-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The PDF the pod rendered from one version of a template. */
export const PUT = ownedAgentRoute<{ agentId: string; itemId: string; version: string }>(
  async ({ agent, request, params }) => await putTemplatePdf(agent, request, params.version, templateId(params.itemId))
);
