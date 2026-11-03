import { noContent, parse, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { requireConversationOfAgent } from "@/assistant/conversation-store";
import { recordGithubExport } from "@/assistant/github-store";
import { githubExportReportBody } from "@/assistant/schemas";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A conversation's session reporting its GitHub export: the issue number it created with `gh`, or why it could not. */
export const PUT = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const body = parse(githubExportReportBody, await readJson(request));
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  await recordGithubExport(prisma, conversation, body);
  return noContent();
});
