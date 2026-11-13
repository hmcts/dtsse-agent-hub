import type { NextRequest } from "next/server";
import { json, parse, readJson } from "@/agent-api/http";
import { startRecording } from "@/feedback/recording-store";
import { noStore } from "@/feedback/review-api";
import { startFeedbackRecordingBody } from "@/feedback/schemas";
import { prisma } from "@/store/prisma";
import { reviewRoute } from "../../review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Starts a recording by the viewer through the link, before the shell starts its microphone and the widget's rrweb. */
export async function POST(request: NextRequest, context: { params: Promise<{ token: string }> }): Promise<Response> {
  return await reviewRoute(request, "start feedback recording", async (viewer) => {
    const { token } = await context.params;
    parse(startFeedbackRecordingBody, await readJson(request));
    return noStore(json({ recording: await startRecording(prisma, viewer.oid, token) }, 201));
  });
}
