import { readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { getTemplate, putTemplate } from "@/assistant/docmosis-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The conversation's primary template, its oldest, which is all a client older than `/docmosis-templates` knows of. */
export const GET = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => await getTemplate(agent, request));

/** Writes the primary template, and makes it at base version 0 while there is none. */
export const PUT = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => await putTemplate(agent, await readJson(request)));
