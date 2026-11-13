import type { NextRequest } from "next/server";
import { json } from "@/agent-api/http";
import { noStore } from "@/feedback/review-api";
import { mentionablePeople, openFeedbackLink } from "@/feedback/store";
import { prisma } from "@/store/prisma";
import { reviewRoute } from "../../review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who a comment through the link may `@` name: the project's team and the link's own commenters. */
export async function GET(request: NextRequest, context: { params: Promise<{ token: string }> }): Promise<Response> {
  return await reviewRoute(request, "list feedback people", async (viewer) => {
    const { token } = await context.params;
    const { link } = await openFeedbackLink(prisma, viewer.oid, token);
    return noStore(json({ people: await mentionablePeople(prisma, link.projectId, link.id) }));
  });
}
