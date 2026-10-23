import { noContent, parse, readJson } from "@/agent-api/http";
import { virtualRoute } from "@/agent-api/route";
import { recordJiraExport } from "@/assistant/jira-store";
import { jiraExportReportBody } from "@/assistant/schemas";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The pod's result for one of its conversations' Jira exports: the issue key it created, or why it could not. */
export const PUT = virtualRoute<{ virtualAgentId: string; conversationId: string }>(async ({ virtualAgent, request, params }) => {
  await recordJiraExport(prisma, virtualAgent.id, params.conversationId, parse(jiraExportReportBody, await readJson(request)));
  return noContent();
});
