import type { NextRequest } from "next/server";
import { grantsHeldBy } from "@/access/load";
import { canViewAgent, canViewTranscript } from "@/access/rules";
import { errorResponse, HttpError, json } from "@/agent-api/http";
import { findAgent, isUuid } from "@/agents/store";
import { messageIdOf } from "@/messages/limits";
import { prisma } from "@/store/prisma";
import { agentConversation, type ConversationCursor } from "@/transcripts/views";
import { uiViewer } from "../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function entryId(value: string, name: string): bigint {
  // Entry ids are a bigint like message ids, so they share the parser.
  const id = messageIdOf(value);
  if (id === undefined) {
    throw new HttpError(400, `${name} must be a transcript entry id`);
  }
  return id;
}

function cursorOf(query: URLSearchParams): ConversationCursor {
  const before = query.get("before");
  const after = query.get("after");
  if (before !== null && after !== null) {
    throw new HttpError(400, "send at most one of before and after");
  }
  if (before !== null) {
    return { before: entryId(before, "before") };
  }
  return after === null ? {} : { after: entryId(after, "after") };
}

/**
 * A page of an agent's conversation: `?before=<entry id>` for earlier entries, `?after=<entry id>` for those stored
 * since. An agent the viewer cannot see is refused as missing.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  const { id } = await params;
  const agent = isUuid(id) ? await findAgent(prisma, id) : undefined;
  const grants = await grantsHeldBy(prisma, viewer.oid);
  if (agent === undefined || !canViewAgent(viewer.oid, agent, grants)) {
    return errorResponse(404, "no such agent");
  }
  if (!canViewTranscript(viewer.oid, agent, grants)) {
    return errorResponse(403, "you may not read this agent's transcript");
  }
  let cursor: ConversationCursor;
  try {
    cursor = cursorOf(request.nextUrl.searchParams);
  } catch (error) {
    return errorResponse(400, error instanceof HttpError ? error.message : "bad request");
  }
  return json(await agentConversation(prisma, viewer.oid, { id: agent.id, ownerOid: agent.ownerOid }, grants, cursor));
}
