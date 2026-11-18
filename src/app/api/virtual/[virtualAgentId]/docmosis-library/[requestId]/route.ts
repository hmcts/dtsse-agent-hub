import { HttpError, noContent, parse } from "@/agent-api/http";
import { virtualRoute } from "@/agent-api/route";
import { indexAnswerBody, MAX_INDEX_BYTES } from "@/assistant/docmosis-library";
import { answerIndex } from "@/assistant/docmosis-library-store";
import { readBytes } from "@/assistant/upload-body";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The pod's answer to one check of its owner's template library. Read as bytes up to `MAX_INDEX_BYTES`, because an
 * index of a few thousand templates is past the 256 KiB `readJson` allows every other body.
 */
export const PUT = virtualRoute<{ virtualAgentId: string; requestId: string }>(async ({ virtualAgent, request, params }) => {
  const bytes = await readBytes(request, MAX_INDEX_BYTES).catch((error: unknown) => {
    throw error instanceof HttpError && error.status === 413 ? new HttpError(413, `an index answer is at most ${MAX_INDEX_BYTES} bytes`) : error;
  });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "the request body is not valid JSON");
  }
  await answerIndex(prisma, virtualAgent, params.requestId, parse(indexAnswerBody, body));
  return noContent();
});
