import type { Environment } from "../auth/settings.ts";
import { createFeedbackBlobs, type FeedbackBlobs } from "../feedback/blob.ts";
import { type FeedbackBlobSettings, feedbackBlobSettings } from "../feedback/settings.ts";

/**
 * Where journey videos' bytes are. The account is the one prototype feedback uses, with the same identity, user
 * delegation key and Azurite locally (`feedback/blob.ts`); the videos have a container of their own, so a role, a
 * lifecycle rule or a delete-everything can never reach a recording through the other feature's. Read per call from
 * the environment, as the feedback settings are, because the chart's secrets reach `process.env` late.
 */

export const DEFAULT_VIDEO_CONTAINER = "assistant-videos";

export type VideoBlobs = FeedbackBlobs;

/** The video blob settings, or `undefined` when there is no account to use or the container name is one Azure would refuse. */
export function videoBlobSettings(env: Environment = process.env): FeedbackBlobSettings | undefined {
  return feedbackBlobSettings({ ...env, FEEDBACK_STORAGE_CONTAINER: env.ASSISTANT_VIDEO_STORAGE_CONTAINER?.trim() || DEFAULT_VIDEO_CONTAINER });
}

const globalForBlobs = globalThis as unknown as { agentHubVideoBlobs?: { key: string; blobs: VideoBlobs } };

/**
 * The process's one video blob client, or `undefined` when there is no storage configured. On `globalThis` because the
 * route handlers and the sweeps are in separate module graphs, and one client keeps one delegation key.
 */
export function videoBlobs(env: Environment = process.env): VideoBlobs | undefined {
  const settings = videoBlobSettings(env);
  if (settings === undefined) {
    return undefined;
  }
  const key = JSON.stringify(settings);
  if (globalForBlobs.agentHubVideoBlobs?.key !== key) {
    globalForBlobs.agentHubVideoBlobs = { key, blobs: createFeedbackBlobs(settings) };
  }
  return globalForBlobs.agentHubVideoBlobs.blobs;
}
