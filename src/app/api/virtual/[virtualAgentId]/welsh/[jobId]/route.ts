import { noContent, parse, readJson } from "@/agent-api/http";
import { virtualRoute } from "@/agent-api/route";
import { welshAnswerBody } from "@/assistant/welsh";
import { answerWelsh } from "@/assistant/welsh-store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The pod's answer to one of its owner's Welsh jobs: what scripts/welsh printed, or why it did not run. */
export const PUT = virtualRoute<{ virtualAgentId: string; jobId: string }>(async ({ virtualAgent, request, params }) => {
  await answerWelsh(prisma, virtualAgent, params.jobId, parse(welshAnswerBody, await readJson(request)));
  return noContent();
});
