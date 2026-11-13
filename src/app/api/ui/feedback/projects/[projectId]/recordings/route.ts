import type { NextRequest } from "next/server";
import { json } from "@/agent-api/http";
import { listRecordings } from "@/feedback/recording-store";
import { feedbackRoute, noStore } from "@/feedback/review-api";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The project's recordings, newest first, narrowed by `?link=` and `?author=`. */
export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string }> }): Promise<Response> {
  return await feedbackRoute(request, "list team feedback recordings", async (viewer) => {
    const { projectId } = await context.params;
    const query = request.nextUrl.searchParams;
    const recordings = await listRecordings(
      prisma,
      viewer.oid,
      { projectId },
      { linkId: query.get("link") || undefined, authorOid: query.get("author") || undefined }
    );
    return noStore(json({ recordings }));
  });
}
