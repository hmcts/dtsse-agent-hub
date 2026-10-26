import { HttpError, noContent, parse, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { recordConfluenceExport } from "@/assistant/confluence-store";
import { confluenceExportReportBody } from "@/assistant/schemas";
import { conversationOfAgent } from "@/assistant/store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A conversation's session reporting its Confluence export: the id of the page it created with `twg`, or why it could not. */
export const PUT = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const body = parse(confluenceExportReportBody, await readJson(request));
  const conversation = await conversationOfAgent(prisma, agent.id);
  if (conversation === undefined) {
    throw new HttpError(404, "that agent is not an assistant conversation's");
  }
  await recordConfluenceExport(prisma, conversation, body);
  return noContent();
});
