import { HttpError, json, parse, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { artefactPutBody } from "@/assistant/schemas";
import { type Artefact, ArtefactConflict, conversationOfAgent, readArtefact, writeArtefact } from "@/assistant/store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function artefactBody(artefact: Artefact) {
  return {
    title: artefact.title,
    markdown: artefact.markdown,
    version: artefact.version,
    updated_by: artefact.updatedBy,
    updated_at: artefact.updatedAt?.toISOString() ?? null
  };
}

async function conversationOf(agentId: string) {
  const conversation = await conversationOfAgent(prisma, agentId);
  if (conversation === undefined) {
    throw new HttpError(404, "that agent is not an assistant conversation's");
  }
  return conversation;
}

export const GET = ownedAgentRoute<{ agentId: string }>(async ({ agent }) => {
  const conversation = await conversationOf(agent.id);
  return json(artefactBody(await readArtefact(prisma, conversation.id)));
});

export const PUT = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const body = parse(artefactPutBody, await readJson(request));
  const conversation = await conversationOf(agent.id);
  try {
    const version = await writeArtefact(prisma, conversation, {
      title: body.title ?? null,
      markdown: body.markdown,
      baseVersion: body.base_version,
      by: "agent"
    });
    return json({ version });
  } catch (error) {
    if (error instanceof ArtefactConflict) {
      throw new HttpError(409, error.message, { current: artefactBody(error.current) });
    }
    throw error;
  }
});
