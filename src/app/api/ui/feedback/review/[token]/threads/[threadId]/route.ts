import type { NextRequest } from "next/server";
import { json, parse, readJson } from "@/agent-api/http";
import { noStore } from "@/feedback/review-api";
import { patchFeedbackThreadBody } from "@/feedback/schemas";
import { patchThread } from "@/feedback/thread-store";
import { prisma } from "@/store/prisma";
import { reviewRoute } from "../../../review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Resolves, reopens or detaches a thread on the link, or re-anchors it. */
export async function PATCH(request: NextRequest, context: { params: Promise<{ token: string; threadId: string }> }): Promise<Response> {
  return await reviewRoute(request, "change feedback thread", async (viewer) => {
    const { token, threadId } = await context.params;
    const patch = parse(patchFeedbackThreadBody, await readJson(request));
    const thread = await patchThread(prisma, viewer.oid, { token }, threadId, patch);
    return noStore(json({ thread }));
  });
}
