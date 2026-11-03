import { HttpError } from "../agent-api/http.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { announce, type ConversationRow } from "./conversation-row.ts";
import { GITHUB_EXPORT_TIMEOUT_MS, GITHUB_SELECT, type GithubExportView, githubExportView, readGithubProject, readGithubRepo } from "./github.ts";
import { hasPod } from "./pods.ts";
import { MAX_GITHUB_ERROR } from "./schemas.ts";

/**
 * A conversation's GitHub export as the hub keeps it, by the same rules as its Jira export (`jira-store.ts`): claimed
 * when its owner asks, carried to the conversation's session with each message while it is pending, and recorded
 * when the session reports what came of it.
 */

export async function readGithubExport(db: Database, conversationId: string, now: Date = new Date()): Promise<GithubExportView> {
  const row = await db.assistantConversation.findUnique({ where: { id: conversationId }, select: GITHUB_SELECT });
  return row === null ? { status: "none" } : githubExportView(row, now);
}

/**
 * Starts an export of the conversation's document to `repo`'s issues, for its session to carry out, and answers the
 * repository as it was stored. `project` is the GitHub Project to add the issue to, or none. Refused when the conversation already has an issue or an export still pending, in the
 * one statement that writes it, and refused outright for a conversation with no pod, for the reasons
 * `requestJiraExport` gives.
 */
export async function requestGithubExport(
  prisma: PrismaClient,
  conversation: Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">,
  repo: unknown,
  project: unknown = null,
  now: Date = new Date()
): Promise<string> {
  if (!hasPod(conversation)) {
    throw new HttpError(409, "this chat is a session on your own computer, which cannot export to GitHub; download the document and attach it yourself");
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
  await prisma.$transaction(async (tx) => {
    const updated = await tx.$executeRaw`
      UPDATE assistant_conversation
         SET github_export_id = gen_random_uuid(), github_repo = ${checked}, github_status = 'pending', github_error = NULL,
             github_requested_at = ${now}, updated_at = ${now},
             github_project_owner = ${board?.owner ?? null}, github_project_number = ${board?.number ?? null}::int,
             github_project_title = ${board?.title ?? null}, github_project_error = NULL
       WHERE id = ${conversation.id}::uuid
         AND github_number IS NULL
         AND artefact_version > 0
         AND (github_status IS DISTINCT FROM 'pending' OR github_requested_at < ${staleBefore})
    `;
    if (updated === 0) {
      const row = await tx.assistantConversation.findUnique({ where: { id: conversation.id }, select: { artefactVersion: true, ...GITHUB_SELECT } });
      if (row === null) {
        throw new HttpError(404, "that conversation no longer exists");
      }
      if (row.githubNumber !== null) {
        throw new HttpError(409, `this document is already on GitHub as ${row.githubRepo}#${row.githubNumber}`);
      }
      if (row.artefactVersion === 0) {
        throw new HttpError(409, "write the document before exporting it");
      }
      throw new HttpError(409, "this document is already being exported");
    }
    await announce(tx, conversation);
  });
  return checked;
}

export type GithubExportResult = { export_id: string; number: number; project_error?: string } | { export_id: string; error: string };

/**
 * The session's result for an export. Kept only for the conversation's current export, and never over a number: a
 * report for an export the person has since retried, or a second report, changes nothing.
 */
export async function recordGithubExport(
  prisma: PrismaClient,
  conversation: Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">,
  result: GithubExportResult,
  now: Date = new Date()
): Promise<void> {
  const where = { id: conversation.id, githubExportId: result.export_id, githubNumber: null };
  const data =
    "number" in result
      ? {
          githubStatus: "done",
          githubNumber: result.number,
          githubError: null,
          githubProjectError: result.project_error?.slice(0, MAX_GITHUB_ERROR) ?? null,
          updatedAt: now
        }
      : { githubStatus: "failed", githubError: result.error.slice(0, MAX_GITHUB_ERROR), updatedAt: now };
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.assistantConversation.updateMany({ where, data });
    if (count > 0) {
      await announce(tx, conversation);
    }
  });
}
