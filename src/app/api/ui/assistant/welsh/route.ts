import type { NextRequest } from "next/server";
import { errorResponse, json, readJson } from "@/agent-api/http";
import { isWelshKind, isWelshProduct, QUICK_WELSH_KINDS, WELSH_QUICK_WAIT_MS, welshArgs } from "@/assistant/welsh";
import { askWelsh, waitForWelsh } from "@/assistant/welsh-store";
import { realtime } from "@/realtime/process";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { uiRefusals, uiViewer } from "../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Starts a Welsh translation job for the signed-in person, in their own assistant's pod, and answers a quick one
 * (`info`, `search`) as a lookup does or a long one with its id to read back. The owner comes from the session cookie
 * and never from the request. See "Welsh translation jobs" in docs/agent-api.md.
 *
 * A route rather than a server action because the search box cancels a search as the person types on, which an
 * aborted fetch can do and a server action cannot.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (!virtualAgentsEnabled()) {
    return errorResponse(404, "Welsh translations are not available on this deployment");
  }
  return await uiRefusals("welsh job", async () => {
    const body = (await readJson(request)) as { kind?: unknown; product?: unknown; args?: unknown };
    if (!isWelshKind(body.kind)) {
      return errorResponse(400, "that is not something the Welsh page does");
    }
    if (!isWelshProduct(body.product)) {
      return errorResponse(400, "pick a service first");
    }
    const checked = welshArgs(body.kind, body.product, body.args);
    if ("error" in checked) {
      return errorResponse(400, checked.error);
    }
    // Subscribed before the job is recorded, so an answer that comes back before the wait starts is still heard.
    const { hub, listener } = realtime();
    await listener.ready();
    const asked = await askWelsh(prisma, { viewerOid: viewer.oid, kind: body.kind, product: body.product, args: checked.args });
    if ("answer" in asked) {
      return json(asked.answer);
    }
    if (!QUICK_WELSH_KINDS.includes(body.kind)) {
      return json({ status: "pending", job_id: asked.jobId });
    }
    return json(await waitForWelsh(prisma, hub, viewer.oid, asked.jobId, { timeoutMs: WELSH_QUICK_WAIT_MS, signal: request.signal }));
  });
}
