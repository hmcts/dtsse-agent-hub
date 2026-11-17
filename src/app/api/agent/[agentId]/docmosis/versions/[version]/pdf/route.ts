import { HttpError, noContent } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { requireConversationOfAgent } from "@/assistant/conversation-store";
import { versionParam } from "@/assistant/deck-build";
import { isPdf, KEEP_PDF, MAX_PDF_BYTES } from "@/assistant/docmosis";
import { docmosisView, putDocmosisPdf } from "@/assistant/docmosis-store";
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
  const revisionText = new URL(request.url).searchParams.get("revision");
  const revision = revisionText !== null && /^\d{1,9}$/.test(revisionText) ? Number(revisionText) : undefined;
  if (revision === undefined) {
    throw new HttpError(400, "revision is required: the whole number the PDF was rendered at, from the answer to PUT …/docmosis");
  }
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const bytes = await readBytes(request, MAX_PDF_BYTES).catch((error: unknown) => {
    throw error instanceof HttpError && error.status === 413 ? new HttpError(413, `a PDF is at most ${MAX_PDF_BYTES} bytes`) : error;
  });
  if (!isPdf(bytes)) {
    throw new HttpError(400, "that is not a PDF");
  }
  const stored = await putDocmosisPdf(prisma, conversation.id, version, revision, bytes);
  if (stored === "gone") {
    throw new HttpError(404, `the template has no version ${version} that keeps a PDF: only the latest ${KEEP_PDF} do`);
  }
  if (stored === "stale") {
    throw new HttpError(409, `version ${version} is no longer at revision ${revision}`, { current: await docmosisView(prisma, conversation.id, version) });
  }
  return noContent();
});
