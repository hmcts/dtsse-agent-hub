import { HttpError } from "@/agent-api/http";
import { virtualRoute } from "@/agent-api/route";
import { podFile } from "@/assistant/welsh-store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A spreadsheet the owner uploaded, for their pod to read before it runs the job that names it. */
export const GET = virtualRoute<{ virtualAgentId: string; fileId: string }>(async ({ virtualAgent, params }) => {
  const file = await podFile(prisma, virtualAgent, params.fileId);
  if (file === undefined) {
    throw new HttpError(404, "no such file");
  }
  return new Response(Buffer.from(file.bytes), {
    headers: { "content-type": "application/octet-stream", "content-length": String(file.bytes.length), "cache-control": "no-store" }
  });
});
