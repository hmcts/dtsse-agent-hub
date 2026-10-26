import type { NextRequest } from "next/server";
import { errorResponse, json, readJson } from "@/agent-api/http";
import { askLookup, waitForLookup } from "@/assistant/lookup-store";
import { isLookupKind, LOOKUP_WAIT_MS, type LookupResponse, lookupQuery, SPACE_KEY_RE, searchable } from "@/assistant/lookups";
import { realtime } from "@/realtime/process";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { uiRefusals, uiViewer } from "../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Searches the signed-in person's own Jira or Confluence, as them, through their assistant's pod, and answers what it
 * found. The owner comes from the session cookie and never from the request, so there is nobody else's Atlassian to
 * ask. See "Atlassian lookups" in docs/agent-api.md.
 *
 * A route rather than a server action because the panel cancels a search as the person types on, and an aborted
 * fetch is something a server action cannot be.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (!virtualAgentsEnabled()) {
    return errorResponse(404, "searching Atlassian is not available on this deployment");
  }
  return await uiRefusals("atlassian lookup", async () => {
    const body = (await readJson(request)) as { kind?: unknown; query?: unknown; space?: unknown; sign_in?: unknown };
    if (!isLookupKind(body.kind)) {
      return errorResponse(400, "kind must be jira_project or confluence_page");
    }
    const space = body.kind === "confluence_page" && typeof body.space === "string" && body.space !== "" ? body.space : null;
    if (space !== null && !SPACE_KEY_RE.test(space)) {
      return errorResponse(400, "that is not a Confluence space key");
    }
    const query = lookupQuery(body.query);
    const signIn = body.sign_in === true;
    if (!signIn && !searchable(query)) {
      return json({ status: "done", results: [] } satisfies LookupResponse);
    }
    // Subscribed before the lookup is recorded, so an answer that comes back before the wait starts is still heard.
    const { hub, listener } = realtime();
    await listener.ready();
    const asked = await askLookup(prisma, { viewerOid: viewer.oid, kind: body.kind, query: query === "" ? "-" : query, space, signIn });
    if ("answer" in asked) {
      return json(asked.answer);
    }
    if (signIn) {
      // The pod answers once the person has finished signing in, which takes minutes; the panel follows the sign-in
      // through the page instead, and searches again when it is done.
      return json({ status: "signing_in" } satisfies LookupResponse);
    }
    return json(await waitForLookup(prisma, hub, asked.lookupId, { timeoutMs: LOOKUP_WAIT_MS, signal: request.signal }));
  });
}
