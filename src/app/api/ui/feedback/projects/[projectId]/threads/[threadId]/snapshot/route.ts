import type { NextRequest } from "next/server";
import { errorResponse, json } from "@/agent-api/http";
import { feedbackBlobs } from "@/feedback/blob";
import { noStore } from "@/feedback/review-api";
import { getThread } from "@/feedback/thread-store";
import { prisma } from "@/store/prisma";
import { teamRoute } from "../../../../team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A read-only URL for the page snapshot taken with a thread, for the comments view to rebuild. */
export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string; threadId: string }> }): Promise<Response> {
  return await teamRoute(request, "read feedback snapshot", async (viewer) => {
    const { projectId, threadId } = await context.params;
    const thread = await getThread(prisma, viewer.oid, { projectId }, threadId);
    const blobs = feedbackBlobs();
    if (thread.snapshotBlob === null || blobs === undefined) {
      return errorResponse(404, "that thread has no snapshot");
    }
    return noStore(json({ url: await blobs.readUrl(thread.snapshotBlob) }));
  });
}
