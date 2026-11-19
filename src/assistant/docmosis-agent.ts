import { HttpError, json, noContent } from "../agent-api/http.ts";
import type { AgentRow } from "../agents/store.ts";
import { prisma } from "../store/prisma.ts";
import { UUID_RE } from "./artefact-store.ts";
import { requireConversationOfAgent } from "./conversation-store.ts";
import { versionParam } from "./deck-build.ts";
import { checkDocmosisPut, isPdf, KEEP_PDF, MAX_PDF_BYTES } from "./docmosis.ts";
import { docmosisView, putDocmosisPdf, writeAgentDocmosis } from "./docmosis-store.ts";
import { readBytes } from "./upload-body.ts";

/**
 * What `/api/agent/{id}/docmosis`, which reads and writes the conversation's primary template, and
 * `/docmosis-templates/{itemId}`, which names one, both answer: `item` is the template's id, or `undefined` for the primary.
 */

const MISSING = "the conversation has no such Docmosis template";

/** The id in a path, or a 404 for what no template can have. */
export function templateId(value: string): string {
  if (!UUID_RE.test(value)) {
    throw new HttpError(404, MISSING);
  }
  return value;
}

/** The latest version, or with `?version=N` one kept version, with the version the template is at now. */
export async function getTemplate(agent: AgentRow, request: Request, item?: string): Promise<Response> {
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const asked = new URL(request.url).searchParams.get("version");
  const version = asked === null ? undefined : versionParam(asked);
  if (asked !== null && version === undefined) {
    throw new HttpError(400, "the version must be a whole number from 1");
  }
  const found = await docmosisView(prisma, conversation.id, item, version);
  if (found === null) {
    throw new HttpError(404, version === undefined ? MISSING : `the template does not keep version ${version}`);
  }
  return json(item === undefined ? found : { id: item, ...found });
}

export async function putTemplate(agent: AgentRow, body: unknown, item?: string): Promise<Response> {
  const conversation = await requireConversationOfAgent(prisma, agent.id);
  const checked = checkDocmosisPut(body);
  if (!checked.ok) {
    throw new HttpError(400, checked.error);
  }
  const { version, revision } = await writeAgentDocmosis(prisma, {
    conversationId: conversation.id,
    ...(item === undefined ? {} : { item }),
    body: checked.value,
    agent
  });
  return json({ version, revision });
}

/** The PDF the pod rendered from one version of a template. */
export async function putTemplatePdf(agent: AgentRow, request: Request, versionText: string, item?: string): Promise<Response> {
  const version = versionParam(versionText);
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
  const stored = await putDocmosisPdf(prisma, conversation.id, item, version, revision, bytes);
  if (stored === "gone") {
    throw new HttpError(404, `the template has no version ${version} that keeps a PDF: only the latest ${KEEP_PDF} do`);
  }
  if (stored === "stale") {
    throw new HttpError(409, `version ${version} is no longer at revision ${revision}`, {
      current: await docmosisView(prisma, conversation.id, item, version)
    });
  }
  return noContent();
}
