import { HttpError, noContent } from "@/agent-api/http";
import { virtualRoute } from "@/agent-api/route";
import { answerablePodJob, answerPodJob } from "@/assistant/pod-job-store";
import { readBytes } from "@/assistant/upload-body";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The pod's answer to one of its owner's pod jobs: `{status: "done", result}` or `{status: "failed", error, detail?}`.
 * A job that is not this pod's or no longer pending is ignored, unread, with the same 204.
 */
export const PUT = virtualRoute<{ virtualAgentId: string; jobId: string }>(async ({ virtualAgent, request, params }) => {
  const job = await answerablePodJob(prisma, virtualAgent.id, params.jobId);
  if (job === undefined) {
    return noContent();
  }
  await answerPodJob(prisma, job, await readAnswer(request, job.definition.maxResultBytes));
  return noContent();
});

/** The answer, read as bytes up to its kind's own cap, whether that is under the agent API's or over it. */
async function readAnswer(request: Request, limit: number): Promise<unknown> {
  const bytes = await readBytes(request, limit).catch((error: unknown) => {
    throw error instanceof HttpError && error.status === 413 ? new HttpError(413, `the answer is larger than ${limit} bytes`) : error;
  });
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "the request body is not valid JSON");
  }
}
