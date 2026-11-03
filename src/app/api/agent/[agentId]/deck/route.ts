import { HttpError, json, parse, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { requireConversationOfAgent } from "@/assistant/conversation-store";
import { checkOutline, deckPutBody } from "@/assistant/deck";
import { type Deck, DeckConflict, readDeck, writeDeck } from "@/assistant/deck-store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function deckBody(deck: Deck) {
  return {
    title: deck.title,
    outline: deck.outline,
    version: deck.version,
    updated_by: deck.updatedBy,
    updated_at: deck.updatedAt?.toISOString() ?? null,
    pptx: deck.pptx
  };
}

export const GET = ownedAgentRoute<{ agentId: string }>(async ({ agent }) => {
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  return json(deckBody(await readDeck(prisma, conversation.id)));
});

export const PUT = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const body = parse(deckPutBody, await readJson(request));
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const checked = checkOutline(body.outline);
  if (!checked.ok) {
    throw new HttpError(400, checked.error);
  }
  try {
    const written = await writeDeck(prisma, conversation, {
      outline: checked.outline,
      baseVersion: body.base_version,
      by: "agent",
      summary: body.summary ?? null
    });
    return json(written);
  } catch (error) {
    if (error instanceof DeckConflict) {
      throw new HttpError(409, error.message, { current: deckBody(error.current) });
    }
    throw error;
  }
});
