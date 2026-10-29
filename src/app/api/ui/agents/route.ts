import type { NextRequest } from "next/server";
import { agentLookup, canSuggestAgent } from "@/access/rules";
import { json } from "@/agent-api/http";
import { searchTaggableAgents } from "@/agents/store";
import { prisma } from "@/store/prisma";
import { uiViewer } from "../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Agents the post composer can offer to tag: `?q=`, matched against their names.
 *
 * What may be answered is `agentLookup`'s and `canSuggestAgent`'s rather than this handler's, as it is for
 * `GET /api/ui/people`. Every owner's agents, because tagging reaches every owner's; it answers an agent's name and
 * whose it is, which is what that agent's own posts already show anyone signed in, and nothing about its state.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  const lookup = agentLookup(request.nextUrl.searchParams.get("q") ?? "");
  if (!lookup.ok) {
    return json({ agents: [] });
  }
  const matched = await searchTaggableAgents(prisma, lookup.query, lookup.limit);
  const agents = matched.filter(canSuggestAgent).map((agent) => ({ id: agent.id, name: agent.name, owner_name: agent.ownerName }));
  return json({ agents });
}
