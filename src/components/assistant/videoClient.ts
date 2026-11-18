import { WAKING_RETRIES, WAKING_RETRY_MS } from "@/components/assistant/AtlassianSearch";
import { type PodJobEvents, PodJobRefused, requestPodJob, waitForPodJob } from "@/components/assistant/podJobClient";

/** The browser's end of a conversation's journey video and of posting it to Jira. See "Journey videos" in docs/agent-api.md. */

const ATTACH_KIND = "jira.attach-video";

export const videoUrl = (conversationId: string): string => `/api/ui/assistant/video/${encodeURIComponent(conversationId)}`;
export const captionsUrl = (conversationId: string, videoId: string): string => `${videoUrl(conversationId)}/captions?v=${encodeURIComponent(videoId)}`;

export interface VideoChapter {
  at: number;
  title: string;
}

/** What `GET /api/ui/assistant/video/{id}` answers. */
export interface VideoDetail {
  video_id: string;
  name: string;
  bytes: number;
  has_captions: boolean;
  chapters: VideoChapter[];
  coverage: string;
  coverage_summary: string | null;
  content_mismatches: string;
  jira_key: string | null;
  posted: { key: string; url: string; at: string } | null;
  finished_at: string;
  play_url: string;
  expires_in: number;
}

/** The video as the hub holds it now, or `undefined` when the chat has none the viewer may watch. */
export async function readVideo(
  conversationId: string,
  { signal, fetchImpl = fetch }: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}
): Promise<VideoDetail | undefined> {
  const response = await fetchImpl(videoUrl(conversationId), { cache: "no-store", ...(signal === undefined ? {} : { signal }) });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`the video read answered ${response.status}`);
  }
  return (await response.json()) as VideoDetail;
}

/** How a post ended. `refused` is the hub turning the request down before anything ran on the pod. */
export type PostOutcome =
  | { status: "done"; issueKey: string; url: string; commented: boolean }
  | { status: "failed"; error: string; detail?: string }
  | { status: "refused"; httpStatus: number; error: string }
  | { status: "waking" | "unsupported" | "no_pod" | "assistant_gone" | "missing" };

export interface PostOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  events?: PodJobEvents;
  onWaking?: () => void;
  onPending?: () => void;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

/** Attaches the video to a Jira issue as the `jira.attach-video` pod job, asked again every few seconds while the assistant starts. */
export async function postVideo(
  conversationId: string,
  request: { issueKey: string; videoId: string },
  { signal, fetchImpl = fetch, events, onWaking, onPending, wait = sleep, pollMs }: PostOptions = {}
): Promise<PostOutcome> {
  const args = { issue_key: request.issueKey, video_id: request.videoId };
  try {
    let asked = await requestPodJob(conversationId, ATTACH_KIND, args, { signal, fetchImpl });
    for (let retries = WAKING_RETRIES; asked.status === "waking" && retries > 0 && signal?.aborted !== true; retries -= 1) {
      onWaking?.();
      await wait(WAKING_RETRY_MS, signal);
      asked = await requestPodJob(conversationId, ATTACH_KIND, args, { signal, fetchImpl });
    }
    if (asked.status !== "pending") {
      return { status: asked.status };
    }
    onPending?.();
    const job = await waitForPodJob(conversationId, asked.job_id, { signal, fetchImpl, events, ...(pollMs === undefined ? {} : { pollMs }) });
    if (job.status === "missing") {
      return { status: "missing" };
    }
    if (job.status === "done") {
      const result = job.result as { issue_key: string; url: string; commented: boolean };
      return { status: "done", issueKey: result.issue_key, url: result.url, commented: result.commented };
    }
    if (job.status === "timeout") {
      return { status: "failed", error: "timeout" };
    }
    return { status: "failed", error: job.error ?? "failed", ...(job.detail === undefined ? {} : { detail: job.detail }) };
  } catch (error) {
    if (error instanceof PodJobRefused) {
      return { status: "refused", httpStatus: error.status, error: error.message };
    }
    throw error;
  }
}

function sentence(words: string): string {
  const trimmed = words.trim();
  const capital = `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/** One plain sentence for a post that did not end with the video attached. */
export function postFailureSentence(outcome: Exclude<PostOutcome, { status: "done" }>): string {
  switch (outcome.status) {
    case "waking":
      return "Your assistant is still starting. Try again in a minute.";
    case "unsupported":
      return "Your assistant needs an update to post videos. It gets one the next time it restarts.";
    case "no_pod":
      return "Videos can only be posted from a chat with an assistant of its own.";
    case "assistant_gone":
      return "This chat's assistant has been replaced, so it cannot post the video.";
    case "missing":
      return "The post did not finish. Try again.";
    case "refused":
      return outcome.httpStatus === 429 ? "You have posted a lot of videos in the last hour. Try again later." : sentence(outcome.error);
    case "failed":
      switch (outcome.error) {
        case "not_signed_in":
          return "Sign in to Atlassian in your assistant, then post the video again.";
        case "issue_not_found":
          return "Jira could not find that issue, or your account cannot see it.";
        case "forbidden":
          return "Your Jira account cannot attach files to that issue.";
        case "video_gone":
          return "The video in this chat has changed. Open it again.";
        case "download_failed":
          return "Your assistant could not fetch the video from storage. Try again.";
        case "timeout":
          return "Your assistant did not finish in time. Try again.";
        default:
          return outcome.detail === undefined ? "The video could not be posted. Try again." : sentence(outcome.detail);
      }
  }
}
