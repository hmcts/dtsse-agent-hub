import { HttpError } from "../agent-api/http.ts";
import { podLacks } from "../agents/client-features.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { exportableDocument } from "./artefact-store.ts";
import { announce, type ConversationRow } from "./conversation-row.ts";
import { GITHUB_EXPORT_TIMEOUT_MS, GITHUB_SELECT, type GithubExportView, githubExportView, readGithubProject, readGithubRepo } from "./github.ts";
import { JIRA_SELECT } from "./jira.ts";
import { duplicateTicket } from "./jira-store.ts";
import { hasPod } from "./pods.ts";
import { MAX_GITHUB_ERROR } from "./schemas.ts";

/**
 * A document's GitHub export as the hub keeps it, by the same rules as its Jira export (`jira-store.ts`): claimed
 * when its owner asks, carried to the conversation's session with each message while it is pending, and recorded
 * when the session reports what came of it.
 */

export async function readGithubExport(db: Database, documentId: string, now: Date = new Date()): Promise<GithubExportView> {
  const row = await db.assistantDocument.findUnique({ where: { id: documentId }, select: GITHUB_SELECT });
  return row === null ? { status: "none" } : githubExportView(row, now);
}

/**
 * Starts an export of one of the conversation's documents, as `exportableDocument` allows, to `repo`'s issues, for its session to carry out, and answers the
 * repository as it was stored. `project` is the GitHub Project to add the issue to, or none. Refused when the document already has an issue or an export still pending, in the
 * one statement that writes it, and refused outright for a conversation with no pod, for the reasons
 * `requestJiraExport` gives.
 */
export async function requestGithubExport(
  prisma: PrismaClient,
  conversation: Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">,
  document: unknown,
  repo: unknown,
  project: unknown = null,
  now: Date = new Date()
): Promise<{ repo: string; exportId: string }> {
  if (!hasPod(conversation)) {
    throw new HttpError(409, "this chat is a session on your own computer, which cannot export to GitHub; download the document and attach it yourself");
  }
  // A client older than GitHub exports would read only the chat message, and a session that acted on it alone would
  // make an issue the hub never hears of: the export times out, and a retry makes a second. `github-lookups` came in
  // the same client as `github export`, so it is the claim that says the pod can carry one out.
  const pod = await prisma.virtualAgent.findUnique({
    where: { id: conversation.virtualAgentId as string },
    select: { status: true, clientFeatures: true, agent: { select: { clientFeatures: true } } }
  });
  if (pod !== null && podLacks(pod, "github-lookups")) {
    throw new HttpError(409, "your assistant needs an update to create GitHub issues; it gets one the next time it restarts");
  }
  const checked = readGithubRepo(repo);
  if (checked === undefined) {
    throw new HttpError(400, "name the GitHub repository as owner/name, such as hmcts/cft-workspace");
  }
  const board = readGithubProject(project);
  if (board === undefined) {
    throw new HttpError(400, "pick the GitHub Project from the search, or none");
  }
  const staleBefore = new Date(now.getTime() - GITHUB_EXPORT_TIMEOUT_MS);
  const exportId = await prisma.$transaction(async (tx) => {
    const documentId = await exportableDocument(tx, conversation, document, "ticket");
    const written = await tx.$queryRaw<{ id: string }[]>`
      UPDATE assistant_document
         SET github_export_id = CASE WHEN github_status = 'pending' AND github_repo = ${checked} AND github_export_id IS NOT NULL THEN github_export_id ELSE gen_random_uuid() END,
             github_repo = ${checked}, github_status = 'pending', github_error = NULL,
             github_requested_at = ${now},
             github_project_owner = ${board?.owner ?? null}, github_project_number = ${board?.number ?? null}::int,
             github_project_title = ${board?.title ?? null}, github_project_error = NULL
       WHERE id = ${documentId}::uuid
         AND github_number IS NULL
         AND version > 0
         AND (github_status IS DISTINCT FROM 'pending' OR github_requested_at < ${staleBefore})
         -- One ticket a document, whichever tool made it, as requestJiraExport has it.
         AND jira_key IS NULL
         AND (jira_status IS DISTINCT FROM 'pending' OR jira_requested_at < ${staleBefore})
      RETURNING github_export_id::text AS id
    `;
    if (written[0] === undefined) {
      const row = await tx.assistantDocument.findUniqueOrThrow({ where: { id: documentId }, select: { version: true, ...GITHUB_SELECT, ...JIRA_SELECT } });
      if (row.githubNumber !== null) {
        throw new HttpError(409, `this document is already on GitHub as ${row.githubRepo}#${row.githubNumber}`);
      }
      if (row.jiraKey !== null) {
        throw new HttpError(409, `this document is already in Jira as ${row.jiraKey}`);
      }
      if (row.version === 0) {
        throw new HttpError(409, "write the document before exporting it");
      }
      throw new HttpError(409, "this document is already being exported");
    }
    await announce(tx, conversation);
    return written[0].id;
  });
  return { repo: checked, exportId };
}

export type GithubExportResult = { export_id: string; number: number; project_error?: string } | { export_id: string; error: string };

/**
 * The session's result for an export, found by its id among the conversation's documents. Kept only for that document's current export, and never over a number: a
 * report for an export the person has since retried, or a second report, changes nothing.
 */
export async function recordGithubExport(
  prisma: PrismaClient,
  conversation: Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">,
  result: GithubExportResult
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // One ticket a document at report time too, under the row's lock: see `recordJiraExport`.
    await tx.$queryRaw`SELECT 1 FROM assistant_document WHERE conversation_id = ${conversation.id}::uuid AND github_export_id = ${result.export_id}::uuid FOR UPDATE`;
    const document = await tx.assistantDocument.findFirst({
      where: { conversationId: conversation.id, githubExportId: result.export_id, githubNumber: null },
      select: { id: true, githubRepo: true, jiraKey: true }
    });
    if (document === null) {
      return;
    }
    const data = !("number" in result)
      ? { githubStatus: "failed", githubError: result.error.slice(0, MAX_GITHUB_ERROR) }
      : document.jiraKey !== null
        ? { githubStatus: "failed", githubError: duplicateTicket(`${document.githubRepo}#${result.number}`, `in Jira as ${document.jiraKey}`) }
        : {
            githubStatus: "done",
            githubNumber: result.number,
            githubError: null,
            githubProjectError: result.project_error?.slice(0, MAX_GITHUB_ERROR) ?? null
          };
    await tx.assistantDocument.update({ where: { id: document.id }, data });
    await announce(tx, conversation);
  });
}
