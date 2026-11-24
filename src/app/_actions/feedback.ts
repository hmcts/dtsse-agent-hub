"use server";

import { revalidatePath } from "next/cache";
import { HttpError, parse } from "@/agent-api/http";
import { deleteConversation, startConversation } from "@/app/_actions/assistant";
import { markMentionsSeen } from "@/feedback/mention-store";
import { markProjectSeen, pinProject } from "@/feedback/nav-store";
import { type ProbeOutcome, probeTarget } from "@/feedback/probe";
import { checkTheme, isRefineMode, MAX_THEME, refinementRequest } from "@/feedback/refinement";
import { recordRefinement, refinableThreads, setThreadsTheme } from "@/feedback/refinement-store";
import {
  createFeedbackProjectBody,
  type FeedbackLinkInput,
  feedbackLinkBody,
  feedbackMembersBody,
  feedbackReplyBody,
  feedbackSettingsBody
} from "@/feedback/schemas";
import { feedbackEnabled } from "@/feedback/settings";
import {
  addLink,
  archiveProject,
  createProject,
  type FeedbackLinkView,
  type FeedbackPerson,
  type FeedbackProjectView,
  getProject,
  revokeLink,
  rotateLink,
  setMembers,
  updateSettings
} from "@/feedback/store";
import { checkTargetUrl, publicAddresses } from "@/feedback/targets";
import { type FeedbackCommentView, type FeedbackThreadView, listThreads, patchThread, replyToThread } from "@/feedback/thread-store";
import { prisma } from "@/store/prisma";
import { requireViewer } from "@/viewer/current";
import { type ActionResult, runAction, text } from "@/web/action";

/**
 * The team's side of prototype feedback: setting a project up, its links, team and settings, and replying to and
 * resolving its threads. Each re-reads the viewer; who may do which is the stores', through `src/access/rules.ts`.
 * Every write revalidates the feedback pages, which read it back.
 */

const OFF: { ok: false; error: string } = { ok: false, error: "prototype feedback is not available on this deployment" };

const PAGES = "/assistant/feedback";

/** Refuses a link to anywhere no link may point, as the proxy would refuse to fetch it. */
async function publicLinks(links: readonly FeedbackLinkInput[]): Promise<void> {
  for (const [index, link] of links.entries()) {
    const checked = checkTargetUrl(link.targetUrl);
    if (!checked.ok) {
      throw new HttpError(400, `links.${index}.url: ${checked.reason}`);
    }
    if ((await publicAddresses(checked.hostname)).length === 0) {
      throw new HttpError(400, `links.${index}.url: must be on the public internet`);
    }
  }
}

export async function createFeedbackProject(input: unknown): Promise<ActionResult<{ project: FeedbackProjectView }>> {
  return await runAction<{ project: FeedbackProjectView }>("create feedback project", async () => {
    if (!feedbackEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const body = parse(createFeedbackProjectBody, input);
    await publicLinks(body.links);
    const project = await createProject(prisma, viewer.oid, body);
    revalidatePath("/assistant", "layout");
    return { ok: true, project };
  });
}

export async function addFeedbackLink(input: { projectId: unknown; link: unknown }): Promise<ActionResult<{ link: FeedbackLinkView }>> {
  return await runAction<{ link: FeedbackLinkView }>("add feedback link", async () => {
    if (!feedbackEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const body = parse(feedbackLinkBody, input.link);
    await publicLinks([body]);
    const link = await addLink(prisma, viewer.oid, text(input.projectId), body);
    revalidatePath(PAGES, "layout");
    return { ok: true, link };
  });
}

export async function revokeFeedbackLink(input: { projectId: unknown; linkId: unknown }): Promise<ActionResult> {
  return await runAction("revoke feedback link", async () => {
    if (!feedbackEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    await revokeLink(prisma, viewer.oid, text(input.projectId), text(input.linkId));
    revalidatePath(PAGES, "layout");
    return { ok: true };
  });
}

export async function rotateFeedbackLink(input: { projectId: unknown; linkId: unknown }): Promise<ActionResult<{ link: FeedbackLinkView }>> {
  return await runAction<{ link: FeedbackLinkView }>("rotate feedback link", async () => {
    if (!feedbackEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const link = await rotateLink(prisma, viewer.oid, text(input.projectId), text(input.linkId));
    revalidatePath(PAGES, "layout");
    return { ok: true, link };
  });
}

export async function setFeedbackMembers(input: { projectId: unknown; memberOids: unknown }): Promise<ActionResult<{ members: FeedbackPerson[] }>> {
  return await runAction<{ members: FeedbackPerson[] }>("set feedback members", async () => {
    if (!feedbackEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const { memberOids } = parse(feedbackMembersBody, { member_oids: input.memberOids });
    const members = await setMembers(prisma, viewer.oid, text(input.projectId), memberOids);
    revalidatePath("/assistant", "layout");
    return { ok: true, members };
  });
}

export async function updateFeedbackSettings(input: { projectId: unknown; settings: unknown }): Promise<ActionResult<{ project: FeedbackProjectView }>> {
  return await runAction<{ project: FeedbackProjectView }>("update feedback settings", async () => {
    if (!feedbackEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const settings = parse(feedbackSettingsBody, input.settings);
    const project = await updateSettings(prisma, viewer.oid, text(input.projectId), settings);
    revalidatePath(PAGES, "layout");
    return { ok: true, project };
  });
}

export async function archiveFeedbackProject(input: { projectId: unknown }): Promise<ActionResult> {
  return await runAction("archive feedback project", async () => {
    if (!feedbackEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    await archiveProject(prisma, viewer.oid, text(input.projectId));
    revalidatePath("/assistant", "layout");
    return { ok: true };
  });
}

export async function replyToFeedbackThread(input: {
  projectId: unknown;
  threadId: unknown;
  body: unknown;
}): Promise<ActionResult<{ comment: FeedbackCommentView }>> {
  return await runAction<{ comment: FeedbackCommentView }>("reply to feedback thread", async () => {
    if (!feedbackEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const { body } = parse(feedbackReplyBody, { body: input.body });
    const comment = await replyToThread(prisma, viewer.oid, { projectId: text(input.projectId) }, text(input.threadId), body);
    revalidatePath(PAGES, "layout");
    return { ok: true, comment };
  });
}

export async function setFeedbackThreadStatus(input: {
  projectId: unknown;
  threadId: unknown;
  status: unknown;
}): Promise<ActionResult<{ thread: FeedbackThreadView }>> {
  return await runAction<{ thread: FeedbackThreadView }>("set feedback thread status", async () => {
    if (!feedbackEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    if (input.status !== "open" && input.status !== "resolved") {
      return { ok: false, error: "status: must be open or resolved" };
    }
    const thread = await patchThread(prisma, viewer.oid, { projectId: text(input.projectId) }, text(input.threadId), { status: input.status });
    revalidatePath(PAGES, "layout");
    return { ok: true, thread };
  });
}

/** For the setup wizard: whether an address will work as a link, before anything is saved. */
export async function probeFeedbackLink(input: { url: unknown }): Promise<ActionResult<{ probe: ProbeOutcome }>> {
  return await runAction<{ probe: ProbeOutcome }>("probe feedback link", async () => {
    if (!feedbackEnabled()) {
      return OFF;
    }
    await requireViewer();
    return { ok: true, probe: await probeTarget(text(input.url)) };
  });
}

/** Pins the project in the viewer's own sidebar, or unpins it. */
export async function pinFeedbackProject(input: { projectId: unknown; pinned: unknown }): Promise<ActionResult> {
  return await runAction("pin feedback project", async () => {
    if (!feedbackEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    await pinProject(prisma, viewer.oid, text(input.projectId), input.pinned);
    revalidatePath("/assistant", "layout");
    return { ok: true };
  });
}

/**
 * Marks the project seen by the viewer, which clears its count in their sidebar. Called by the project's page once it
 * is on screen rather than as the page renders, so a prefetch of the page marks nothing.
 */
export async function markFeedbackProjectSeen(input: { projectId: unknown }): Promise<ActionResult> {
  return await runAction("mark feedback project seen", async () => {
    if (!feedbackEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    await markProjectSeen(prisma, viewer.oid, text(input.projectId));
    revalidatePath("/assistant", "layout");
    return { ok: true };
  });
}

/**
 * Marks the mentions the viewer's Mentions list showed them as seen, which takes them off the sidebar's count. Only
 * those it showed, so one that arrived since is still counted; called once the list is on screen, as a project's seen is.
 */
export async function markFeedbackMentionsSeen(input: { commentIds: unknown }): Promise<ActionResult> {
  return await runAction("mark feedback mentions seen", async () => {
    if (!feedbackEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const ids = Array.isArray(input.commentIds) ? input.commentIds.filter((id): id is string => typeof id === "string") : [];
    if ((await markMentionsSeen(prisma, viewer.oid, ids)) > 0) {
      revalidatePath("/assistant", "layout");
    }
    return { ok: true };
  });
}

/** The strings of an argument that should be a list of them; anything else in it, or anything else at all, is dropped. */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Gives the team's chosen threads a theme, or clears it; a reviewer's link reaches none of this. */
export async function setFeedbackTheme(input: { projectId: unknown; threadIds: unknown; theme: unknown }): Promise<ActionResult<{ changed: number }>> {
  return await runAction<{ changed: number }>("set feedback theme", async () => {
    if (!feedbackEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const theme = checkTheme(input.theme);
    if (theme === undefined) {
      return { ok: false, error: typeof input.theme === "string" ? `Keep the theme to ${MAX_THEME} characters` : "theme: must be text, or null to clear it" };
    }
    const changed = await setThreadsTheme(prisma, viewer.oid, text(input.projectId), strings(input.threadIds), theme);
    revalidatePath(PAGES, "layout");
    return { ok: true, changed };
  });
}

/**
 * Starts a conversation that refines the team's chosen threads into one Jira story (`mode` "one") or, comment by
 * comment, into as many as they need ("each"), and records that it
 * does, so the threads show the issue once it is exported. The conversation is started as any is, so it is refused
 * the same way while the Workspace is off or the person has accounts still to connect.
 */
export async function refineFeedback(input: { projectId: unknown; threadIds: unknown; mode: unknown }): Promise<ActionResult<{ id: string }>> {
  return await runAction<{ id: string }>("refine feedback", async () => {
    if (!feedbackEnabled()) {
      return OFF;
    }
    if (!isRefineMode(input.mode)) {
      return { ok: false, error: "mode: must be one or each" };
    }
    const mode = input.mode;
    const viewer = await requireViewer();
    const projectId = text(input.projectId);
    const ids = await refinableThreads(prisma, viewer.oid, projectId, strings(input.threadIds));
    const [project, all] = await Promise.all([getProject(prisma, viewer.oid, projectId), listThreads(prisma, viewer.oid, { projectId })]);
    const labels = new Map(project.links.map((link) => [link.id, link.label]));
    const request = refinementRequest({
      projectName: project.name,
      mode,
      threads: all.filter((thread) => ids.includes(thread.id)),
      linkLabel: labels.size > 1 ? (linkId) => labels.get(linkId) ?? "a removed link" : null,
      now: new Date()
    });
    const { threadIds, ...first } = request;
    const started = await startConversation(first);
    if (!started.ok) {
      return started;
    }
    try {
      // Only the threads the message listed: one left out to keep it short is not in the stories it leads to.
      await recordRefinement(prisma, viewer.oid, projectId, started.id, threadIds);
    } catch (error) {
      // The project changed under the click (archived, its threads gone): a chat its threads never hear of is no use,
      // and a second click would only start another, so it goes.
      await deleteConversation({ conversationId: started.id });
      throw error;
    }
    revalidatePath(PAGES, "layout");
    return { ok: true, id: started.id };
  });
}
