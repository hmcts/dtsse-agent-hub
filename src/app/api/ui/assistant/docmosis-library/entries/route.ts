import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { isCommitSha } from "@/assistant/docmosis-library";
import { readLibraryEntries } from "@/assistant/docmosis-library-store";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { uiRefusals, uiViewer } from "../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The entries of the signed-in person's template library index at one commit. Cached by the browser for a day as
 * immutable, since a commit's entries never change: the page asks again only when the status names another commit.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (!virtualAgentsEnabled()) {
    return errorResponse(404, "the template library is not available on this deployment");
  }
  return await uiRefusals("template library entries", async () => {
    const commit = request.nextUrl.searchParams.get("commit") ?? "";
    if (!isCommitSha(commit)) {
      return errorResponse(400, "commit must be a commit SHA-1, 40 lowercase hex");
    }
    const index = await readLibraryEntries(prisma, viewer.oid, commit);
    if (index === undefined) {
      return errorResponse(404, "that is not the template library index you hold");
    }
    return Response.json(index, { headers: { "Cache-Control": "private, max-age=86400, immutable" } });
  });
}
