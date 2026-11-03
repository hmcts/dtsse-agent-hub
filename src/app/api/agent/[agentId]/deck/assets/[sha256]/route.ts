import { createHash } from "node:crypto";
import { HttpError, json } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { requireConversationOfAgent } from "@/assistant/conversation-store";
import { assetRef, imageInfo, isSha256, MAX_ASSET_BYTES, MAX_DECK_ASSET_BYTES, MAX_IMAGE_SIDE } from "@/assistant/deck";
import { putDeckAsset, readDeckAsset } from "@/assistant/deck-store";
import { readBytes } from "@/assistant/upload-body";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { agentId: string; sha256: string };

function digestOf(sha256: string): string {
  if (!isSha256(sha256)) {
    throw new HttpError(400, "the path must end with the picture's SHA-256, as 64 lowercase hex digits");
  }
  return sha256;
}

/** One picture for the conversation's deck, stored under the digest of its bytes. */
export const PUT = ownedAgentRoute<Params>(async ({ agent, request, params }) => {
  const sha256 = digestOf(params.sha256);
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const bytes = await readBytes(request, MAX_ASSET_BYTES).catch((error: unknown) => {
    throw error instanceof HttpError && error.status === 413 ? new HttpError(413, `a picture is at most ${MAX_ASSET_BYTES} bytes`) : error;
  });
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new HttpError(400, "the bytes' SHA-256 is not the one in the path");
  }
  const info = imageInfo(bytes);
  if (info === undefined) {
    throw new HttpError(400, `that is not a PNG, JPEG or GIF of 1 to ${MAX_IMAGE_SIDE} pixels each way`);
  }
  const result = await putDeckAsset(prisma, conversation.id, sha256, bytes, info);
  if (result === "deck_full") {
    throw new HttpError(
      409,
      `a deck uses at most ${MAX_DECK_ASSET_BYTES} bytes of pictures: those its latest version names, and those uploaded in the last hour`
    );
  }
  return json({ asset: assetRef(sha256) }, result === "stored" ? 201 : 200);
});

export const GET = ownedAgentRoute<Params>(async ({ agent, params }) => {
  const sha256 = digestOf(params.sha256);
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const asset = await readDeckAsset(prisma, conversation.id, sha256);
  if (asset === undefined) {
    throw new HttpError(404, "the deck does not hold that picture");
  }
  return new Response(Buffer.from(asset.bytes), {
    headers: { "content-type": asset.mime, "content-length": String(asset.bytes.length), "x-content-type-options": "nosniff", "cache-control": "no-store" }
  });
});
