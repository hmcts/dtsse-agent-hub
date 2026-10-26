import { HttpError } from "../agent-api/http.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import {
  CONFLUENCE_EXPORT_TIMEOUT_MS,
  CONFLUENCE_SELECT,
  type ConfluenceExportView,
  type ConfluenceParent,
  checkParent,
  confluenceExportView
} from "./confluence.ts";
import { MAX_CONFLUENCE_ERROR } from "./schemas.ts";
import { announce, type ConversationRow } from "./store.ts";

/**
 * A conversation's Confluence export as the hub keeps it: claimed when its owner asks, carried to the conversation's
 * session with each message while it is pending, and recorded when the session reports what came of it. The same
 * shape as `jira-store.ts`, kept apart so either export can change without the other.
 */

export async function readConfluenceExport(db: Database, conversationId: string, now: Date = new Date()): Promise<ConfluenceExportView> {
  const row = await db.assistantConversation.findUnique({ where: { id: conversationId }, select: CONFLUENCE_SELECT });
  return row === null ? { status: "none" } : confluenceExportView(row, now);
}

/**
 * Starts an export of the conversation's document to a new page under `parent`, for its session to carry out, and
 * answers the parent as checked. Refused when the document is already in Confluence or an export is still pending, so
 * a second click or tab cannot ask for a second page: the check and the write are one statement.
 */
export async function requestConfluenceExport(
  prisma: PrismaClient,
  conversation: Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">,
  rawParent: unknown,
  now: Date = new Date()
): Promise<ConfluenceParent> {
  const parent = checkParent(rawParent);
  if (parent === undefined) {
    throw new HttpError(400, "pick a Confluence page to put the document under");
  }
  const staleBefore = new Date(now.getTime() - CONFLUENCE_EXPORT_TIMEOUT_MS);
  await prisma.$transaction(async (tx) => {
    const updated = await tx.$executeRaw`
      UPDATE assistant_conversation
         SET confluence_export_id = gen_random_uuid(), confluence_space_id = ${parent.space_id}, confluence_space_key = ${parent.space_key},
             confluence_space_name = ${parent.space_name}, confluence_parent_id = ${parent.id}, confluence_parent_title = ${parent.title},
             confluence_status = 'pending', confluence_error = NULL, confluence_requested_at = ${now}, updated_at = ${now}
       WHERE id = ${conversation.id}::uuid
         AND confluence_page_id IS NULL
         AND artefact_version > 0
         AND (confluence_status IS DISTINCT FROM 'pending' OR confluence_requested_at < ${staleBefore})
    `;
    if (updated === 0) {
      const row = await tx.assistantConversation.findUnique({ where: { id: conversation.id }, select: { artefactVersion: true, confluencePageId: true } });
      if (row === null) {
        throw new HttpError(404, "that conversation no longer exists");
      }
      if (row.confluencePageId !== null) {
        throw new HttpError(409, "this document is already in Confluence");
      }
      if (row.artefactVersion === 0) {
        throw new HttpError(409, "write the document before exporting it");
      }
      throw new HttpError(409, "this document is already being published");
    }
    await announce(tx, conversation);
  });
  return parent;
}

export type ConfluenceExportResult = { export_id: string; page_id: string; title?: string } | { export_id: string; error: string };

/**
 * The session's result for an export. Kept only for the conversation's current export, and never over a page: a
 * report for an export the person has since retried, or a second report, changes nothing.
 */
export async function recordConfluenceExport(
  prisma: PrismaClient,
  conversation: Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">,
  result: ConfluenceExportResult,
  now: Date = new Date()
): Promise<void> {
  const where = { id: conversation.id, confluenceExportId: result.export_id, confluencePageId: null };
  const data =
    "page_id" in result
      ? {
          confluenceStatus: "done",
          confluencePageId: result.page_id,
          confluencePageTitle: result.title ?? null,
          confluenceError: null,
          confluenceExportedAt: now,
          updatedAt: now
        }
      : { confluenceStatus: "failed", confluenceError: result.error.slice(0, MAX_CONFLUENCE_ERROR), updatedAt: now };
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.assistantConversation.updateMany({ where, data });
    if (count > 0) {
      await announce(tx, conversation);
    }
  });
}
