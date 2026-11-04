import { noContent, parse, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { recordConfluenceExport } from "@/assistant/confluence-store";
import { requireConversationOfAgent } from "@/assistant/conversation-store";
import { confluenceExportReportBody } from "@/assistant/schemas";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A conversation's session reporting its Confluence export: the id of the page it created with `twg`, or why it could not. */
export const PUT = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const body = parse(confluenceExportReportBody, await readJson(request));
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  await recordConfluenceExport(prisma, conversation, body);
  return noContent();
});
