"use server";

import { revalidatePath } from "next/cache";
import { HttpError, parse } from "@/agent-api/http";
import { type ProbeOutcome, probeTarget } from "@/feedback/probe";
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
  revokeLink,
  rotateLink,
  setMembers,
  updateSettings
} from "@/feedback/store";
import { checkTargetUrl, resolvesPublic } from "@/feedback/targets";
import { type FeedbackCommentView, type FeedbackThreadView, patchThread, replyToThread } from "@/feedback/thread-store";
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
    if (!(await resolvesPublic(checked.hostname))) {
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
