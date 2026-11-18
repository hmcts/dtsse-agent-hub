import { ownedAgentRoute } from "@/agent-api/route";
import { getDeck, putDeck } from "@/assistant/deck-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The conversation's primary deck, which is all a client older than `/decks` knows of. */
export const GET = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => await getDeck(agent, request));

/** Writes the primary deck, making it at base 0 while the conversation has none. */
export const PUT = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => await putDeck(agent, request, {}));
