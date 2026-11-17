import { createHash } from "node:crypto";
import { HttpError, json } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { requireConversationOfAgent } from "@/assistant/conversation-store";
import { isSha256 } from "@/assistant/deck";
import { docxRef, isDocx, MAX_DOCX_BYTES } from "@/assistant/docmosis";
import { putDocmosisAsset, readDocmosisDocx } from "@/assistant/docmosis-store";
import { readBytes } from "@/assistant/upload-body";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { agentId: string; sha256: string };

function digestOf(sha256: string): string {
  if (!isSha256(sha256)) {
    throw new HttpError(400, "the path must end with the .docx's SHA-256, as 64 lowercase hex digits");
  }
  return sha256;
}

/** The .docx of the conversation's template, stored under the digest of its bytes. */
export const PUT = ownedAgentRoute<Params>(async ({ agent, request, params }) => {
  const sha256 = digestOf(params.sha256);
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const bytes = await readBytes(request, MAX_DOCX_BYTES).catch((error: unknown) => {
    throw error instanceof HttpError && error.status === 413 ? new HttpError(413, `a .docx is at most ${MAX_DOCX_BYTES} bytes`) : error;
  });
  if (!isDocx(bytes)) {
    throw new HttpError(400, "that is not a .docx");
  }
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new HttpError(400, "the bytes' SHA-256 is not the one in the path");
  }
  await putDocmosisAsset(prisma, conversation.id, sha256, bytes);
  return json({ asset: docxRef(sha256) });
});

export const GET = ownedAgentRoute<Params>(async ({ agent, params }) => {
  const sha256 = digestOf(params.sha256);
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const bytes = await readDocmosisDocx(prisma, conversation.id, sha256);
  if (bytes === null) {
    throw new HttpError(404, "the conversation does not hold that .docx");
  }
  return new Response(Buffer.from(bytes), {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length),
      "x-content-type-options": "nosniff",
      "cache-control": "no-store"
    }
  });
});
