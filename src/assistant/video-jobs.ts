import { z } from "zod";
import { definePodJobKind } from "./pod-jobs.ts";
import { jiraKey } from "./video.ts";
import { hasReadyVideo } from "./video-store.ts";

/**
 * Posting a conversation's journey video to Jira: the `jira.attach-video` pod job. The conversation's pod downloads the
 * recording from Blob Storage, signs `twg` in as its owner, attaches the MP4 to the issue and adds a comment listing the
 * chapters and the coverage summary. See "Journey videos" in docs/agent-api.md.
 */

export const VIDEO_ATTACH_KIND = "jira.attach-video";

export const VIDEO_ATTACH_ERRORS = [
  "no_session",
  "video_gone",
  "download_failed",
  "not_signed_in",
  "twg_missing",
  "issue_not_found",
  "forbidden",
  "upload_failed"
] as const;

export const VIDEO_ATTACH = definePodJobKind({
  kind: VIDEO_ATTACH_KIND,
  args: z.strictObject({ issue_key: jiraKey, video_id: z.uuid() }),
  result: z.strictObject({
    issue_key: jiraKey,
    url: z.string().max(200),
    /** False when the video is attached and only the comment failed. */
    commented: z.boolean()
  }),
  errors: VIDEO_ATTACH_ERRORS,
  // The download, the Atlassian sign-in the person may have to complete on the way, the upload and the comment.
  timeoutMs: 15 * 60_000,
  rateLimit: { limit: 20, windowMs: 60 * 60_000 },
  oneAtATime: true,
  maxResultBytes: 1024,
  precheck: async (db, { conversationId, args }) => {
    const { video_id } = args as { video_id: string };
    return (await hasReadyVideo(db, conversationId, video_id)) ? undefined : { status: 404, error: "that video is no longer in this chat; open it again" };
  }
});
