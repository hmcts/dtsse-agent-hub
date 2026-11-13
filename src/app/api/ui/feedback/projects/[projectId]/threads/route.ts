import type { NextRequest } from "next/server";
import { json } from "@/agent-api/http";
import { noStore } from "@/feedback/review-api";
import { listThreads } from "@/feedback/thread-store";
import { prisma } from "@/store/prisma";
import { teamRoute, teamThreadQuery } from "../../team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The project's threads, narrowed by `?link=`, `?page=`, `?status=` and `?author=`. */
export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string }> }): Promise<Response> {
  return await teamRoute(request, "list team feedback threads", async (viewer) => {
    const { projectId } = await context.params;
    const threads = await listThreads(prisma, viewer.oid, { projectId }, teamThreadQuery(request.nextUrl.searchParams));
    return noStore(json({ threads }));
  });
}
