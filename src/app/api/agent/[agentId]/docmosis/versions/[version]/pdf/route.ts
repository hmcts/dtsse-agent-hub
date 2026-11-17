import { HttpError, noContent } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { requireConversationOfAgent } from "@/assistant/conversation-store";
import { versionParam } from "@/assistant/deck-build";
import { isPdf, KEEP_PDF, MAX_PDF_BYTES } from "@/assistant/docmosis";
import { putDocmosisPdf } from "@/assistant/docmosis-store";
import { readBytes } from "@/assistant/upload-body";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The PDF the pod rendered from one version of the conversation's template. */
export const PUT = ownedAgentRoute<{ agentId: string; version: string }>(async ({ agent, request, params }) => {
  const version = versionParam(params.version);
  if (version === undefined) {
    throw new HttpError(400, "the version must be a whole number from 1");
  }
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const bytes = await readBytes(request, MAX_PDF_BYTES).catch((error: unknown) => {
    throw error instanceof HttpError && error.status === 413 ? new HttpError(413, `a PDF is at most ${MAX_PDF_BYTES} bytes`) : error;
  });
  if (!isPdf(bytes)) {
    throw new HttpError(400, "that is not a PDF");
  }
  if (!(await putDocmosisPdf(prisma, conversation.id, version, bytes))) {
    throw new HttpError(404, `the template has no version ${version} that keeps a PDF: only the latest ${KEEP_PDF} do`);
  }
  return noContent();
});
