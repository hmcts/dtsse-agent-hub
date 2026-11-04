import { noContent, parse, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { requireConversationOfAgent } from "@/assistant/conversation-store";
import { recordJiraExport } from "@/assistant/jira-store";
import { jiraExportReportBody } from "@/assistant/schemas";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A conversation's session reporting its Jira export: the issue key it created with `twg`, or why it could not. */
export const PUT = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const body = parse(jiraExportReportBody, await readJson(request));
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  await recordJiraExport(prisma, conversation, body);
  return noContent();
});
