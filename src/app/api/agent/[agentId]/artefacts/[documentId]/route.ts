import { HttpError, json, noContent, parse, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { ArtefactConflict, artefactJson, readDocument, removeDocument, UUID_RE, writeDocument } from "@/assistant/artefact-store";
import { requireConversationOfAgent } from "@/assistant/conversation-store";
import { artefactPutBody } from "@/assistant/schemas";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { agentId: string; documentId: string };

const MISSING = "that document no longer exists";

function documentId(params: Params): string {
  if (!UUID_RE.test(params.documentId)) {
    throw new HttpError(404, MISSING);
  }
  return params.documentId;
}

export const GET = ownedAgentRoute<Params>(async ({ agent, params }) => {
  const id = documentId(params);
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const document = await readDocument(prisma, conversation.id, id);
  if (document === undefined) {
    throw new HttpError(404, MISSING);
  }
  return json({ id: document.id, kind: document.kind, ...artefactJson(document) });
});

export const PUT = ownedAgentRoute<Params>(async ({ agent, params, request }) => {
  const id = documentId(params);
  const body = parse(artefactPutBody, await readJson(request));
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  try {
    const version = await writeDocument(prisma, conversation, id, {
      title: body.title ?? null,
      markdown: body.markdown,
      baseVersion: body.base_version,
      by: "agent"
    });
    return json({ version });
  } catch (error) {
    if (error instanceof ArtefactConflict) {
      throw new HttpError(409, error.message, { current: artefactJson(error.current) });
    }
    throw error;
  }
});

export const DELETE = ownedAgentRoute<Params>(async ({ agent, params }) => {
  const id = documentId(params);
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  await removeDocument(prisma, conversation, id);
  return noContent();
});
