import type { NextRequest } from "next/server";
import { json, parse, readJson } from "@/agent-api/http";
import { noStore } from "@/feedback/review-api";
import { feedbackReplyBody } from "@/feedback/schemas";
import { replyToThread } from "@/feedback/thread-store";
import { prisma } from "@/store/prisma";
import { reviewRoute } from "../../../../review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A reply on one of the link's threads. */
export async function POST(request: NextRequest, context: { params: Promise<{ token: string; threadId: string }> }): Promise<Response> {
  return await reviewRoute(request, "reply to feedback thread", async (viewer) => {
    const { token, threadId } = await context.params;
    const { body } = parse(feedbackReplyBody, await readJson(request));
    const comment = await replyToThread(prisma, viewer.oid, { token }, threadId, body);
    return noStore(json({ comment }, 201));
  });
}
