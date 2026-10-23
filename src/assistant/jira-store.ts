import { HttpError } from "../agent-api/http.ts";
import { isUuid } from "../agents/store.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { findVirtualAgent, setDesired } from "../virtual-agents/store.ts";
import { isJiraProject, JIRA_EXPORT_TIMEOUT_MS, JIRA_ISSUE_TYPE, JIRA_LABELS, JIRA_SELECT, type JiraExportView, jiraExportView } from "./jira.ts";
import { MAX_JIRA_ERROR } from "./schemas.ts";
import { announce, type ConversationRow } from "./store.ts";

/** A conversation's Jira export as the hub keeps it: asked for by its owner, sent to its pod, reported back. */

export async function readJiraExport(db: Database, conversationId: string, now: Date = new Date()): Promise<JiraExportView> {
  const row = await db.assistantConversation.findUnique({ where: { id: conversationId }, select: JIRA_SELECT });
  return row === null ? { status: "none" } : jiraExportView(row, now);
}

/**
 * Asks the conversation's pod to create its document in `project`'s backlog, and starts the assistant if it is
 * stopped. Refused when the conversation already has a ticket, or an export still pending, so a second click or tab
 * cannot make a second issue: the check and the write are one statement.
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
  const assistant = await findVirtualAgent(prisma, conversation.virtualAgentId);
  if (assistant?.desired === "stopped") {
    await setDesired(prisma, conversation.ownerOid, assistant.id, "running", now);
  }
}

/** A `jira_export` on the sessions stream: what to create, and the id the pod reports it under. */
export interface JiraExportRequest {
  conversation_id: string;
  export_id: string;
  project: string;
  issue_type: string;
  labels: string[];
  summary: string;
  description: string;
}

/** Every pending export of the virtual agent's conversations, oldest first. One timed out is not sent again. */
export async function pendingJiraExports(db: Database, virtualAgentId: string, now: Date = new Date()): Promise<JiraExportRequest[]> {
  const staleBefore = new Date(now.getTime() - JIRA_EXPORT_TIMEOUT_MS);
  const rows = await db.assistantConversation.findMany({
    where: { virtualAgentId, jiraStatus: "pending", jiraKey: null, jiraRequestedAt: { gte: staleBefore } },
    select: { id: true, jiraExportId: true, jiraProject: true, artefactTitle: true, artefactMarkdown: true },
    orderBy: [{ jiraRequestedAt: "asc" }, { id: "asc" }]
  });
  return rows.flatMap((row) =>
    row.jiraExportId === null || row.jiraProject === null
      ? []
      : [
          {
            conversation_id: row.id,
            export_id: row.jiraExportId,
            project: row.jiraProject,
            issue_type: JIRA_ISSUE_TYPE,
            labels: [...JIRA_LABELS],
            summary: row.artefactTitle ?? "Untitled document",
            description: row.artefactMarkdown
          }
        ]
  );
}

export async function pendingJiraExport(
  db: Database,
  virtualAgentId: string,
  conversationId: string,
  now: Date = new Date()
): Promise<JiraExportRequest | undefined> {
  return (await pendingJiraExports(db, virtualAgentId, now)).find((request) => request.conversation_id === conversationId);
}

export type JiraExportResult = { export_id: string; key: string } | { export_id: string; error: string };

/**
 * The pod's result for an export. Kept only for the conversation's current export, and never over a key: a report
 * for an export the person has since retried, or a second report, changes nothing.
 */
export async function recordJiraExport(
  prisma: PrismaClient,
  virtualAgentId: string,
  conversationId: string,
  result: JiraExportResult,
  now: Date = new Date()
): Promise<void> {
  const conversation = isUuid(conversationId)
    ? await prisma.assistantConversation.findFirst({
        where: { id: conversationId, virtualAgentId },
        select: { id: true, virtualAgentId: true, ownerOid: true }
      })
    : null;
  if (conversation === null) {
    throw new HttpError(404, "no such conversation");
  }
  const where = { id: conversationId, jiraExportId: result.export_id, jiraKey: null };
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
