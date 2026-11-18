import { HttpError, json, parse, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { ArtefactConflict, artefactJson, readArtefact, writeArtefact } from "@/assistant/artefact-store";
import { requireConversationOfAgent } from "@/assistant/conversation-store";
import { artefactPutBody } from "@/assistant/schemas";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The conversation's primary document, which is all a client older than `/artefacts` knows of. */
export const GET = ownedAgentRoute<{ agentId: string }>(async ({ agent }) => {
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  return json(artefactJson(await readArtefact(prisma, conversation.id)));
});

export const PUT = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const body = parse(artefactPutBody, await readJson(request));
  const conversation = await requireConversationOfAgent(prisma, agent.id);
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
      throw new HttpError(409, error.message, { current: artefactJson(error.current) });
    }
    throw error;
  }
});
