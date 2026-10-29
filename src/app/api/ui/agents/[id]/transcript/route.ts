import type { NextRequest } from "next/server";
import { canViewTranscript } from "@/access/rules";
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
 * since. One refusal, the missing one: a transcript is its owner's, by `canViewTranscript`, and an agent that is not
 * the viewer's is reported as not existing rather than as forbidden — the same answer an id that is not a UUID gets,
 * so nothing here confirms an id.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  const { id } = await params;
  const agent = isUuid(id) ? await findAgent(prisma, id) : undefined;
  if (agent === undefined || !canViewTranscript(viewer.oid, agent)) {
    return errorResponse(404, "no such agent");
  }
  let cursor: ConversationCursor;
  try {
    cursor = cursorOf(request.nextUrl.searchParams);
  } catch (error) {
    return errorResponse(400, error instanceof HttpError ? error.message : "bad request");
  }
  return json(await agentConversation(prisma, viewer.oid, { id: agent.id, ownerOid: agent.ownerOid }, cursor));
}
