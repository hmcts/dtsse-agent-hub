import { HttpError } from "../agent-api/http.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { exportableDocument } from "./artefact-store.ts";
import { announce, type ConversationRow } from "./conversation-row.ts";
import { GITHUB_SELECT } from "./github.ts";
import { isJiraProject, JIRA_EXPORT_TIMEOUT_MS, JIRA_SELECT, type JiraExportView, jiraExportView } from "./jira.ts";
import { hasPod } from "./pods.ts";
import { MAX_JIRA_ERROR } from "./schemas.ts";

/**
 * A document's Jira export as the hub keeps it: claimed when its owner asks, carried to the conversation's
 * session with each message while it is pending, and recorded when the session reports what came of it.
 */

export async function readJiraExport(db: Database, documentId: string, now: Date = new Date()): Promise<JiraExportView> {
  const row = await db.assistantDocument.findUnique({ where: { id: documentId }, select: JIRA_SELECT });
  return row === null ? { status: "none" } : jiraExportView(row, now);
}

/**
 * Starts an export of one of the conversation's documents, as `exportableDocument` allows, to `project`'s backlog, for its session to carry out. Refused when
 * the document already has a ticket, or an export still pending, so a second click or tab cannot ask for a second
 * issue: the check and the write are one statement. The caller then asks the session, which wakes it.
 *
 * Refused outright for a conversation with no pod, before anything is written, as `requestWake` refuses a wake. The
 * steps go to the session in `assistantFrame`, which `/api/agent/{id}/stream` sends to a pod's session alone, and no
 * pod's sessions stream matches a null `virtual_agent_id` in any case — so claiming the export would set
 * `jira_status = 'pending'` with nothing able to carry it out or report on it, and the footer would say "Creating
 * ticket…" for the whole of `JIRA_EXPORT_TIMEOUT_MS` before failing, on every retry. The UI offers no export here
 * either; this is the half that does not live only on the screen.
 */
export async function requestJiraExport(
  prisma: PrismaClient,
  conversation: Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">,
  document: unknown,
  project: unknown,
  now: Date = new Date()
): Promise<string> {
  if (!hasPod(conversation)) {
    throw new HttpError(409, "this chat is a session on your own computer, which cannot export to Jira; download the document and attach it yourself");
  }
  if (!isJiraProject(project)) {
    throw new HttpError(400, "pick a Jira project to export to");
  }
  const staleBefore = new Date(now.getTime() - JIRA_EXPORT_TIMEOUT_MS);
  const exportId = await prisma.$transaction(async (tx) => {
    const documentId = await exportableDocument(tx, conversation, document, "ticket");
    const written = await tx.$queryRaw<{ id: string }[]>`
      UPDATE assistant_document
         SET jira_export_id = CASE WHEN jira_status = 'pending' AND jira_project = ${project} AND jira_export_id IS NOT NULL THEN jira_export_id ELSE gen_random_uuid() END,
             jira_project = ${project}, jira_status = 'pending', jira_error = NULL,
             jira_requested_at = ${now}
       WHERE id = ${documentId}::uuid
         AND jira_key IS NULL
         AND version > 0
         AND (jira_status IS DISTINCT FROM 'pending' OR jira_requested_at < ${staleBefore})
         -- One ticket a document, whichever tool made it: a person who has since switched to Jira is not offered a
         -- second for a document already on GitHub, or on its way there.
         AND github_number IS NULL
         AND (github_status IS DISTINCT FROM 'pending' OR github_requested_at < ${staleBefore})
      RETURNING jira_export_id::text AS id
    `;
    if (written[0] === undefined) {
      const row = await tx.assistantDocument.findUniqueOrThrow({ where: { id: documentId }, select: { version: true, ...JIRA_SELECT, ...GITHUB_SELECT } });
      if (row.jiraKey !== null) {
        throw new HttpError(409, `this document is already in Jira as ${row.jiraKey}`);
      }
      if (row.githubNumber !== null) {
        throw new HttpError(409, `this document is already on GitHub as ${row.githubRepo}#${row.githubNumber}`);
      }
      if (row.version === 0) {
        throw new HttpError(409, "write the document before exporting it");
      }
      throw new HttpError(409, "this document is already being exported");
    }
    await announce(tx, conversation);
    return written[0].id;
  });
  return exportId;
}

export type JiraExportResult = { export_id: string; key: string } | { export_id: string; error: string };

/**
 * The session's result for an export, found by its id among the conversation's documents. Kept only for that
 * document's current export, and never over a key: a report for an export the person has since retried elsewhere,
 * or a second report, changes nothing.
 *
 * One ticket a document holds at report time as it does at request time: a ticket that arrives after the document
 * has gone to GitHub in the meantime is recorded as a failure naming it, so the person knows there is a second one to
 * delete rather than seeing the document claim two. A key in a project other than the one asked for is kept, with the
 * project it is really in, so the footer says where the ticket went.
 */
export async function recordJiraExport(
  prisma: PrismaClient,
  conversation: Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">,
  result: JiraExportResult
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // The document's row is held while this reads and writes it, so a GitHub report for it, or a second report for
    // this export, waits and then sees what this one wrote, rather than both finding the document free.
    await tx.$queryRaw`SELECT 1 FROM assistant_document WHERE conversation_id = ${conversation.id}::uuid AND jira_export_id = ${result.export_id}::uuid FOR UPDATE`;
    const document = await tx.assistantDocument.findFirst({
      where: { conversationId: conversation.id, jiraExportId: result.export_id, jiraKey: null },
      select: { id: true, githubNumber: true, githubRepo: true }
    });
    if (document === null) {
      return;
    }
    const data = !("key" in result)
      ? { jiraStatus: "failed", jiraError: result.error.slice(0, MAX_JIRA_ERROR) }
      : document.githubNumber !== null
        ? { jiraStatus: "failed", jiraError: duplicateTicket(result.key, `on GitHub as ${document.githubRepo}#${document.githubNumber}`) }
        : { jiraStatus: "done", jiraKey: result.key, jiraProject: result.key.split("-")[0], jiraError: null };
    await tx.assistantDocument.update({ where: { id: document.id }, data });
    await announce(tx, conversation);
  });
}

/** Said when a late ticket arrives for a document already on the other tool: there are now two, and which to delete. */
export function duplicateTicket(late: string, kept: string): string {
  return `This document was already ${kept}, so ${late} is a second ticket for it. Delete ${late} if you do not need it.`;
}
