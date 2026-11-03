import { HttpError } from "@/agent-api/http";
import { virtualRoute } from "@/agent-api/route";
import { isSha256 } from "@/assistant/deck";
import { podDeckBuildAsset } from "@/assistant/deck-build-store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One picture a pending deck build's outline names, for the pod to build it with. */
export const GET = virtualRoute<{ virtualAgentId: string; jobId: string; sha256: string }>(async ({ virtualAgent, params }) => {
  const asset = isSha256(params.sha256) ? await podDeckBuildAsset(prisma, virtualAgent.id, params.jobId, params.sha256) : undefined;
  if (asset === undefined) {
    throw new HttpError(404, "that build has no such picture");
  }
  return new Response(Buffer.from(asset.bytes), {
    headers: { "content-type": asset.mime, "content-length": String(asset.bytes.length), "x-content-type-options": "nosniff", "cache-control": "no-store" }
  });
});
