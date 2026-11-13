import type { NextRequest } from "next/server";
import { json, parse, readJson } from "@/agent-api/http";
import { completeRecording } from "@/feedback/recording-store";
import { noStore } from "@/feedback/review-api";
import { completeFeedbackRecordingBody } from "@/feedback/schemas";
import { prisma } from "@/store/prisma";
import { reviewRoute } from "../../../../review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stops the viewer's recording once its last segment is uploaded, which makes it playable. */
export async function POST(request: NextRequest, context: { params: Promise<{ token: string; recordingId: string }> }): Promise<Response> {
  return await reviewRoute(request, "complete feedback recording", async (viewer) => {
    const { token, recordingId } = await context.params;
    const input = parse(completeFeedbackRecordingBody, await readJson(request));
    return noStore(json({ recording: await completeRecording(prisma, viewer.oid, token, recordingId, input) }));
  });
}
