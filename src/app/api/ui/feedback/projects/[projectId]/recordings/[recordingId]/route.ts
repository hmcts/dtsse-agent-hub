import type { NextRequest } from "next/server";
import { errorResponse, json } from "@/agent-api/http";
import { feedbackBlobs } from "@/feedback/blob";
import { getRecording } from "@/feedback/recording-store";
import { feedbackRoute, noStore } from "@/feedback/review-api";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One recording for the player: its segments, each with a read-only URL, and the markers of threads made during it. */
export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string; recordingId: string }> }): Promise<Response> {
  return await feedbackRoute(request, "read feedback recording", async (viewer) => {
    const { projectId, recordingId } = await context.params;
    const recording = await getRecording(prisma, viewer.oid, { projectId }, recordingId);
    const blobs = feedbackBlobs();
    if (blobs === undefined) {
      return errorResponse(404, "prototype feedback is not available on this deployment");
    }
    const segments = await Promise.all(recording.segments.map(async (segment) => ({ ...segment, url: await blobs.readUrl(segment.blobPath) })));
    return noStore(json({ recording: { ...recording, segments } }));
  });
}
