import { HttpError, json, parse, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { requireConversationOfAgent } from "@/assistant/conversation-store";
import { checkOutline, deckPutBody } from "@/assistant/deck";
import { versionParam } from "@/assistant/deck-build";
import { readDeckVersion } from "@/assistant/deck-history-store";
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

/** The latest version, or with `?version=N` one kept version, with the version the deck is at now. */
export const GET = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const asked = new URL(request.url).searchParams.get("version");
  if (asked === null) {
    return json(deckBody(await readDeck(prisma, conversation.id)));
  }
  const version = versionParam(asked);
  if (version === undefined) {
    throw new HttpError(400, "the version must be a whole number from 1");
  }
  const [found, latest] = await Promise.all([readDeckVersion(prisma, conversation.id, version), readDeck(prisma, conversation.id)]);
  if (found === undefined) {
    throw new HttpError(404, `the deck does not keep version ${version}`);
  }
  return json({
    title: found.title,
    outline: found.outline,
    version: found.version,
    updated_by: found.by,
    updated_at: found.created_at,
    pptx: found.pptx,
    latest_version: latest.version
  });
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
