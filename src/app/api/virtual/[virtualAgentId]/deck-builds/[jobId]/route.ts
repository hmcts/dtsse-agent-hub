import { HttpError, json, noContent, parse, readJson } from "@/agent-api/http";
import { virtualRoute } from "@/agent-api/route";
import { isPptx, MAX_PPTX_BYTES } from "@/assistant/deck";
import { deckBuildErrorBody } from "@/assistant/deck-build";
import { answerDeckBuild, podDeckBuild } from "@/assistant/deck-build-store";
import { readBytes } from "@/assistant/upload-body";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { virtualAgentId: string; jobId: string };

/** The version one of the owner's pending deck builds is of, for the pod to build. */
export const GET = virtualRoute<Params>(async ({ virtualAgent, params }) => {
  const build = await podDeckBuild(prisma, virtualAgent.id, params.jobId);
  if (build === undefined) {
    throw new HttpError(404, "no such build waiting for an answer");
  }
  return json(build);
});

/** The pod's answer to a deck build: the .pptx as the body, or `{error}` as JSON for why there is none. */
export const PUT = virtualRoute<Params>(async ({ virtualAgent, request, params }) => {
  if ((request.headers.get("content-type") ?? "").startsWith("application/json")) {
    const { error } = parse(deckBuildErrorBody, await readJson(request));
    await answerDeckBuild(prisma, virtualAgent.id, params.jobId, { error });
    return noContent();
  }
  const bytes = await readBytes(request, MAX_PPTX_BYTES).catch((error: unknown) => {
    throw error instanceof HttpError && error.status === 413 ? new HttpError(413, `a .pptx is at most ${MAX_PPTX_BYTES} bytes`) : error;
  });
  if (!isPptx(bytes)) {
    throw new HttpError(400, "that is not a .pptx");
  }
  await answerDeckBuild(prisma, virtualAgent.id, params.jobId, { pptx: bytes });
  return noContent();
});
