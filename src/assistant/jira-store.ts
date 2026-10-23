import { HttpError } from "../agent-api/http.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { isJiraProject, JIRA_EXPORT_TIMEOUT_MS, JIRA_SELECT, type JiraExportView, jiraExportView } from "./jira.ts";
import { MAX_JIRA_ERROR } from "./schemas.ts";
import { announce, type ConversationRow } from "./store.ts";

/**
 * A conversation's Jira export as the hub keeps it: claimed when its owner asks, carried to the conversation's
 * session with each message while it is pending, and recorded when the session reports what came of it.
 */

export async function readJiraExport(db: Database, conversationId: string, now: Date = new Date()): Promise<JiraExportView> {
  const row = await db.assistantConversation.findUnique({ where: { id: conversationId }, select: JIRA_SELECT });
  return row === null ? { status: "none" } : jiraExportView(row, now);
}

/**
 * Starts an export of the conversation's document to `project`'s backlog, for its session to carry out. Refused when
 * the conversation already has a ticket, or an export still pending, so a second click or tab cannot ask for a second
 * issue: the check and the write are one statement. The caller then asks the session, which wakes it.
 */
export async function requestJiraExport(
  prisma: PrismaClient,
  conversation: Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">,
  project: unknown,
  now: Date = new Date()
): Promise<void> {
  if (!isJiraProject(project)) {
    throw new HttpError(400, "pick a Jira board from the list");
  }
  const staleBefore = new Date(now.getTime() - JIRA_EXPORT_TIMEOUT_MS);
  await prisma.$transaction(async (tx) => {
    const updated = await tx.$executeRaw`
      UPDATE assistant_conversation
         SET jira_export_id = gen_random_uuid(), jira_project = ${project}, jira_status = 'pending', jira_error = NULL,
             jira_requested_at = ${now}, updated_at = ${now}
       WHERE id = ${conversation.id}::uuid
         AND jira_key IS NULL
         AND artefact_version > 0
         AND (jira_status IS DISTINCT FROM 'pending' OR jira_requested_at < ${staleBefore})
    `;
    if (updated === 0) {
      const row = await tx.assistantConversation.findUnique({ where: { id: conversation.id }, select: { artefactVersion: true, ...JIRA_SELECT } });
      if (row === null) {
        throw new HttpError(404, "that conversation no longer exists");
      }
      if (row.jiraKey !== null) {
        throw new HttpError(409, `this document is already in Jira as ${row.jiraKey}`);
      }
      if (row.artefactVersion === 0) {
        throw new HttpError(409, "write the document before exporting it");
      }
      throw new HttpError(409, "this document is already being exported");
    }
    await announce(tx, conversation);
  });
}

export type JiraExportResult = { export_id: string; key: string } | { export_id: string; error: string };

/**
 * The session's result for an export. Kept only for the conversation's current export, and never over a key: a
 * report for an export the person has since retried, or a second report, changes nothing.
 */
export async function recordJiraExport(
  prisma: PrismaClient,
  conversation: Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">,
  result: JiraExportResult,
  now: Date = new Date()
): Promise<void> {
  const where = { id: conversation.id, jiraExportId: result.export_id, jiraKey: null };
  const data =
    "key" in result
      ? { jiraStatus: "done", jiraKey: result.key, jiraError: null, jiraExportedAt: now, updatedAt: now }
      : { jiraStatus: "failed", jiraError: result.error.slice(0, MAX_JIRA_ERROR), updatedAt: now };
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.assistantConversation.updateMany({ where, data });
    if (count > 0) {
      await announce(tx, conversation);
    }
  });
}
