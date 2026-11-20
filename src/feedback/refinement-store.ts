import { HttpError } from "../agent-api/http.ts";
import { isUuid } from "../agents/ids.ts";
import { notify } from "../realtime/notify.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { MAX_REFINE_THREADS } from "./refinement.ts";
import { writableScope } from "./scope.ts";

/**
 * The team's working on a project's threads beyond replying: giving them a theme, and recording the conversations
 * they were refined in and the Jira issues those produced. Each is the team's alone (`writableScope` with the
 * project, which a reviewer's token never reaches) and refused on an archived project.
 */

function threadIds(ids: readonly string[]): string[] {
  const unique = [...new Set(ids.filter(isUuid))];
  if (unique.length === 0) {
    throw new HttpError(400, "choose at least one comment");
  }
  return unique;
}

/** Gives `ids` of the project's threads `theme`, or clears it with null. Answers how many were changed. */
export async function setThreadsTheme(
  prisma: PrismaClient,
  viewerOid: string,
  projectId: string,
  ids: readonly string[],
  theme: string | null
): Promise<number> {
  const scope = await writableScope(prisma, viewerOid, { projectId });
  const wanted = threadIds(ids);
  return await prisma.$transaction(async (tx) => {
    const { count } = await tx.feedbackThread.updateMany({ where: { projectId: scope.projectId, id: { in: wanted } }, data: { theme } });
    if (count > 0) {
      await notify(tx, { type: "feedback", project_id: scope.projectId, link_id: null });
    }
    return count;
  });
}

/**
 * The threads of `ids` the viewer may refine: the project's, on the team's scope, at most `MAX_REFINE_THREADS`. Refused
 * when none of them is the project's, so a refinement always has something in it.
 */
export async function refinableThreads(prisma: PrismaClient, viewerOid: string, projectId: string, ids: readonly string[]): Promise<string[]> {
  const scope = await writableScope(prisma, viewerOid, { projectId });
  const wanted = threadIds(ids);
  if (wanted.length > MAX_REFINE_THREADS) {
    throw new HttpError(400, `choose at most ${MAX_REFINE_THREADS} comments to refine at once`);
  }
  const found = await prisma.feedbackThread.findMany({ where: { projectId: scope.projectId, id: { in: wanted } }, select: { id: true } });
  if (found.length === 0) {
    throw new HttpError(404, "those comments are not on this project");
  }
  return found.map((thread) => thread.id);
}

/** Records that the viewer's `conversationId` refines `ids` of the project's threads, which they then show. */
export async function recordRefinement(
  prisma: PrismaClient,
  viewerOid: string,
  projectId: string,
  conversationId: string,
  ids: readonly string[]
): Promise<void> {
  const threads = await refinableThreads(prisma, viewerOid, projectId, ids);
  await prisma.$transaction(async (tx) => {
    const conversation = await tx.assistantConversation.count({ where: { id: conversationId, ownerOid: viewerOid } });
    if (conversation === 0) {
      throw new HttpError(404, "that conversation is not yours");
    }
    const refinement = await tx.feedbackRefinement.create({ data: { projectId, conversationId, ownerOid: viewerOid }, select: { id: true } });
    await tx.feedbackRefinementThread.createMany({ data: threads.map((threadId) => ({ refinementId: refinement.id, threadId })) });
    await notify(tx, { type: "feedback", project_id: projectId, link_id: null });
  });
}

/**
 * Notes `key`, a Jira issue just exported from `conversationId`, against the refinement that conversation is, so its
 * threads show it. Nothing for a conversation that is not one, or a key it has already. Called inside the export's
 * own transaction.
 */
export async function recordRefinementJira(db: Database, conversationId: string, key: string): Promise<void> {
  const refinement = await db.feedbackRefinement.findUnique({ where: { conversationId }, select: { id: true, projectId: true, jiraKeys: true } });
  if (refinement === null || refinement.jiraKeys.includes(key)) {
    return;
  }
  await db.feedbackRefinement.update({ where: { id: refinement.id }, data: { jiraKeys: { push: key } } });
  await notify(db, { type: "feedback", project_id: refinement.projectId, link_id: null });
}
