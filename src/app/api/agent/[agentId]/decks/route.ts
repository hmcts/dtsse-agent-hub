import { ownedAgentRoute } from "@/agent-api/route";
import { listDecks, putDeck } from "@/assistant/deck-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every one of the conversation's decks, oldest first, without their outlines. */
export const GET = ownedAgentRoute<{ agentId: string }>(async ({ agent }) => await listDecks(agent));

/** A new deck at version 1, whatever the conversation already holds. */
export const POST = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => await putDeck(agent, request, { create: true }));
