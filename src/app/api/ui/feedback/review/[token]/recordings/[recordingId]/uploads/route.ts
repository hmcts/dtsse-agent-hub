import type { NextRequest } from "next/server";
import { HttpError, json, parse, readJson } from "@/agent-api/http";
import { feedbackBlobs } from "@/feedback/blob";
import { requestSegment } from "@/feedback/recording-store";
import { noStore } from "@/feedback/review-api";
import { feedbackUploadBody } from "@/feedback/schemas";
import { prisma } from "@/store/prisma";
import { reviewRoute } from "../../../../review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Records one audio or replay segment of the viewer's running recording, and answers a write-only URL to put it to. */
export async function POST(request: NextRequest, context: { params: Promise<{ token: string; recordingId: string }> }): Promise<Response> {
  return await reviewRoute(request, "upload feedback segment", async (viewer) => {
    const { token, recordingId } = await context.params;
    const input = parse(feedbackUploadBody, await readJson(request));
    const blobs = feedbackBlobs();
    if (blobs === undefined) {
      throw new HttpError(404, "prototype feedback is not available on this deployment");
    }
    const { segmentId, blobPath } = await requestSegment(prisma, viewer.oid, token, recordingId, input);
    return noStore(json({ url: await blobs.uploadUrl(blobPath), segment_id: segmentId }, 201));
  });
}
