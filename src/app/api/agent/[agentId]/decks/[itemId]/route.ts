import { ownedAgentRoute } from "@/agent-api/route";
import { deckId, deleteDeck, getDeck, putDeck } from "@/assistant/deck-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { agentId: string; itemId: string };

export const GET = ownedAgentRoute<Params>(async ({ agent, request, params }) => await getDeck(agent, request, deckId(params.itemId)));

export const PUT = ownedAgentRoute<Params>(async ({ agent, request, params }) => await putDeck(agent, request, { item: deckId(params.itemId) }));

export const DELETE = ownedAgentRoute<Params>(async ({ agent, params }) => await deleteDeck(agent, deckId(params.itemId)));
