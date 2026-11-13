import type { NextRequest } from "next/server";
import { HttpError, json, parse, readJson } from "@/agent-api/http";
import { feedbackBlobs } from "@/feedback/blob";
import { feedbackRoute, noStore, threadQuery } from "@/feedback/review-api";
import { createFeedbackThreadBody } from "@/feedback/schemas";
import { createThread, listThreads } from "@/feedback/thread-store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string }> };

/** The link's threads the shell shows: `?page_path=` for the page in the frame, `?status=` to narrow them. */
export async function GET(request: NextRequest, context: Context): Promise<Response> {
  return await feedbackRoute(request, "list feedback threads", async (viewer) => {
    const { token } = await context.params;
    const threads = await listThreads(prisma, viewer.oid, { token }, threadQuery(request.nextUrl.searchParams));
    return noStore(json({ threads }));
  });
}

/**
 * A new thread with its first comment. Asked with `snapshot: true`, it answers a write-only URL for the page's
 * snapshot as well, which the shell puts the gzipped rrweb events to.
 */
export async function POST(request: NextRequest, context: Context): Promise<Response> {
  return await feedbackRoute(request, "create feedback thread", async (viewer) => {
    const { token } = await context.params;
    const input = parse(createFeedbackThreadBody, await readJson(request));
    const blobs = input.snapshot ? feedbackBlobs() : undefined;
    if (input.snapshot && blobs === undefined) {
      throw new HttpError(404, "prototype feedback is not available on this deployment");
    }
    const { thread, snapshotPath } = await createThread(prisma, viewer.oid, token, input);
    const snapshotUrl = snapshotPath === null || blobs === undefined ? null : await blobs.uploadUrl(snapshotPath);
    return noStore(json({ thread, snapshot_url: snapshotUrl }, 201));
  });
}
