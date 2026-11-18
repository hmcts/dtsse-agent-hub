import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import { isCommitSha, isEntriesKey } from "@/assistant/docmosis-library";
import { readLibraryEntries } from "@/assistant/docmosis-library-store";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { uiRefusals, uiViewer } from "../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The entries of the signed-in person's template library index at one commit, at the `entries_url` the status gives.
 * Cached by the browser for a day as immutable, since a commit's entries never change: the page asks again only when
 * the status names another address. The owner's own `key` in that address, and `Vary: Cookie`, keep one person's
 * cached list from being served to the next person signed in on the same browser.
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
    const key = request.nextUrl.searchParams.get("key") ?? "";
    if (!isEntriesKey(key)) {
      return errorResponse(400, "key must be the one in the status's entries_url");
    }
    const index = await readLibraryEntries(prisma, viewer.oid, commit, key);
    if (index === undefined) {
      return errorResponse(404, "that is not the template library index you hold");
    }
    return Response.json(index, { headers: { "Cache-Control": "private, max-age=86400, immutable", Vary: "Cookie" } });
  });
}
