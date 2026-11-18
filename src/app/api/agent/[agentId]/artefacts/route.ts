import { json, parse, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { createDocument, documentSummaryJson, listDocuments } from "@/assistant/artefact-store";
import { requireConversationOfAgent } from "@/assistant/conversation-store";
import { artefactCreateBody } from "@/assistant/schemas";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every one of the conversation's documents, oldest first, without their markdown. */
export const GET = ownedAgentRoute<{ agentId: string }>(async ({ agent }) => {
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  return json({ artefacts: (await listDocuments(prisma, conversation.id)).map(documentSummaryJson) });
});

export const POST = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const body = parse(artefactCreateBody, await readJson(request));
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const created = await createDocument(prisma, conversation, { kind: body.kind, title: body.title ?? null, markdown: body.markdown, by: "agent" });
  return json(created, 201);
});
