import { HttpError, noContent, parse, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { recordJiraExport } from "@/assistant/jira-store";
import { jiraExportReportBody } from "@/assistant/schemas";
import { conversationOfAgent } from "@/assistant/store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A conversation's session reporting its Jira export: the issue key it created with `twg`, or why it could not. */
export const PUT = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const body = parse(jiraExportReportBody, await readJson(request));
  const conversation = await conversationOfAgent(prisma, agent.id);
  if (conversation === undefined) {
    throw new HttpError(404, "that agent is not an assistant conversation's");
  }
  await recordJiraExport(prisma, conversation, body);
  return noContent();
});
