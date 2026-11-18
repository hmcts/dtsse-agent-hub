import { HttpError, MAX_REQUEST_BYTES, noContent, readJson } from "@/agent-api/http";
import { virtualRoute } from "@/agent-api/route";
import { answerPodJob, podJobAnswerLimit } from "@/assistant/pod-job-store";
import { readBytes } from "@/assistant/upload-body";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The pod's answer to one of its owner's pod jobs: `{status: "done", result}` or `{status: "failed", error, detail?}`.
 * A job that is not this pod's or no longer pending is ignored, unread, with the same 204.
 */
export const PUT = virtualRoute<{ virtualAgentId: string; jobId: string }>(async ({ virtualAgent, request, params }) => {
  const limit = await podJobAnswerLimit(prisma, virtualAgent.id, params.jobId);
  if (limit === undefined) {
    return noContent();
  }
  await answerPodJob(prisma, virtualAgent.id, params.jobId, limit > MAX_REQUEST_BYTES ? await readLarger(request, limit) : await readJson(request));
  return noContent();
});

/** A kind that answers more than `readJson` reads, read as bytes up to its own cap. */
async function readLarger(request: Request, limit: number): Promise<unknown> {
  const bytes = await readBytes(request, limit).catch((error: unknown) => {
    throw error instanceof HttpError && error.status === 413 ? new HttpError(413, `the answer is larger than ${limit} bytes`) : error;
  });
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "the request body is not valid JSON");
  }
}
