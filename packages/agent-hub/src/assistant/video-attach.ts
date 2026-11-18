// The pod's half of `jira.attach-video`: the conversation's journey video attached to a Jira issue as its owner. The MP4
// is downloaded from Blob Storage by the read URL the agent API gives, `twg` is signed in as the owner, the file is
// uploaded to the issue and a comment lists the chapters and the coverage summary. The result is kept by job id, so a job
// the supervisor runs again is answered with what the first run did instead of attaching the video twice. See
// "Journey videos" in dtsse-agent-hub's docs/agent-api.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ApiError } from "../api.ts";
import { formatStamp } from "../cli/video.ts";
import type { Env } from "../env.ts";
import { JIRA_BROWSE_URL, JIRA_KEY_RE } from "../jira-export.ts";
import { withRetry } from "../retry.ts";
import { hubHome, readJson, writeJson } from "../session.ts";
import { twgFailureLine, twgSignInProblem } from "../twg-export.ts";
import type { AtlassianLoginResult } from "../virtual/atlassian.ts";
import type { RunResult } from "../virtual/process.ts";
import type { VideoChapter } from "../wire.ts";
import { type PodJobContext, PodJobError, type PodJobHandler } from "./pod-jobs.ts";
import { VIDEO_ATTACH_BUDGET_MS, VIDEO_ATTACH_KIND } from "./video-attach-kind.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UPLOAD_TIMEOUT_MS = 6 * 60_000;
const COMMENT_TIMEOUT_MS = 60_000;
const MAX_LINE = 250;

export type VideoAttachResult = { issue_key: string; url: string; commented: boolean };

export type VideoAttachDeps = {
  run: (cmd: string, args: string[], opts: { env: Env; timeoutMs: number; signal?: AbortSignal }) => Promise<RunResult>;
  /** Signs twg in, relaying a device code to the owner. */
  login: (context: PodJobContext) => Promise<AtlassianLoginResult>;
  fetchImpl?: typeof fetch;
  /** Where results are remembered, by job id; `hubHome()/video-posts` unless a test says otherwise. */
  dir?: string;
  /** Where the recording is downloaded to; the system's temporary directory unless a test says otherwise. */
  tmp?: string;
};

export function parseAttachArgs(value: unknown): { issueKey: string; videoId: string } | null {
  const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (
    !raw ||
    Object.keys(raw).some((key) => key !== "issue_key" && key !== "video_id") ||
    typeof raw.issue_key !== "string" ||
    !JIRA_KEY_RE.test(raw.issue_key) ||
    typeof raw.video_id !== "string" ||
    !UUID_RE.test(raw.video_id)
  ) {
    return null;
  }
  return { issueKey: raw.issue_key, videoId: raw.video_id };
}

/** The comment: the file's name, its chapters with their times, and the coverage summary line when there is one. */
export function commentBody(fileName: string, chapters: readonly VideoChapter[], summary: string | null): string {
  const lines = [`Journey video attached: ${fileName}`];
  if (chapters.length > 0) {
    lines.push("", "Chapters", ...chapters.map((chapter) => `- ${formatStamp(chapter.at)} ${chapter.title}`));
  }
  if (summary !== null) {
    lines.push("", `Coverage: ${summary}`);
  }
  return lines.join("\n");
}

function attachFileName(name: string): string {
  const stem = name
    .replace(/\.mp4$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
  return `${stem === "" ? "journey-video" : stem}.mp4`;
}

function classify(result: RunResult, issueKey: string): PodJobError {
  const text = `${result.stdout}\n${result.stderr}`;
  const detail = twgFailureLine(result, `Jira would not take the video for ${issueKey}`, MAX_LINE);
  if (result.code === 127) {
    return new PodJobError("twg_missing", "twg is not installed in your assistant.");
  }
  if (/not found|does not exist|404/i.test(text)) {
    return new PodJobError("issue_not_found", `${issueKey} was not found in Jira, or you cannot see it.`);
  }
  if (/forbidden|permission|not allowed|403|401/i.test(text)) {
    return new PodJobError("forbidden", `You do not have permission to attach files to ${issueKey}.`);
  }
  return new PodJobError("upload_failed", detail);
}

async function download(url: string, to: string, bytes: number, signal: AbortSignal, fetchImpl: typeof fetch): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(url, { signal });
  } catch (e) {
    throw new PodJobError("download_failed", `The video could not be fetched from storage: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok || res.body === null) {
    throw new PodJobError("download_failed", `Storage answered ${res.status} for the video.`);
  }
  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(to, { mode: 0o600 }), { signal });
  if (fs.statSync(to).size !== bytes) {
    throw new PodJobError("download_failed", "The video was not downloaded whole. Try again.");
  }
}

function remembered(dir: string, jobId: string): VideoAttachResult | null {
  const value = readJson(path.join(dir, `${jobId}.json`)) as Partial<VideoAttachResult> | null;
  return value !== null && typeof value.issue_key === "string" && typeof value.url === "string" && typeof value.commented === "boolean"
    ? { issue_key: value.issue_key, url: value.url, commented: value.commented }
    : null;
}

export function videoAttachHandler(deps: VideoAttachDeps): PodJobHandler {
  return {
    kind: VIDEO_ATTACH_KIND,
    budgetMs: VIDEO_ATTACH_BUDGET_MS,
    run: async (args, context) => {
      const parsed = parseAttachArgs(args);
      if (parsed === null) {
        throw new Error("the job's arguments are not ones this client can run");
      }
      const { issueKey, videoId } = parsed;
      const dir = deps.dir ?? path.join(hubHome(), "video-posts");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const known = remembered(dir, context.jobId);
      if (known !== null) {
        return known;
      }
      if (context.agentId === undefined) {
        throw new PodJobError("no_session", "This chat has no assistant session yet. Send it a message, then try again.");
      }
      const agentId = context.agentId;
      const video = await context.api.getVideo(agentId).catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) {
          throw new PodJobError("video_gone", "That video is no longer in this chat.");
        }
        throw e;
      });
      if (video.video_id !== videoId) {
        throw new PodJobError("video_gone", "The chat's video has changed since you opened it. Open it again.");
      }
      const work = fs.mkdtempSync(path.join(deps.tmp ?? os.tmpdir(), "agent-hub-video-"));
      try {
        const fileName = attachFileName(video.name);
        const file = path.join(work, fileName);
        const problem = await twgSignInProblem(
          {
            env: context.env,
            run: (cmd, argv, opts) => deps.run(cmd, argv, { ...opts, signal: context.signal }),
            login: () => deps.login(context),
            print: context.say
          },
          "the attachment"
        );
        if (problem !== null) {
          throw new PodJobError(/not installed/.test(problem) ? "twg_missing" : "not_signed_in", problem);
        }
        await download(video.download_url, file, video.bytes, context.signal, deps.fetchImpl ?? fetch);
        const upload = await deps.run("twg", ["jira", "workitem", "attachment", "upload", `--issue-id=${issueKey}`, `--file=${file}`], {
          env: context.env,
          timeoutMs: UPLOAD_TIMEOUT_MS,
          signal: context.signal
        });
        if (upload.code !== 0) {
          throw classify(upload, issueKey);
        }
        const comment = await deps.run(
          "twg",
          [
            "jira",
            "workitem",
            "comment",
            "create",
            `--issue-id=${issueKey}`,
            `--body=${commentBody(fileName, video.chapters, video.coverage_summary)}`,
            "--body-format=markdown"
          ],
          { env: context.env, timeoutMs: COMMENT_TIMEOUT_MS, signal: context.signal }
        );
        const result: VideoAttachResult = { issue_key: issueKey, url: `${JIRA_BROWSE_URL}${issueKey}`, commented: comment.code === 0 };
        writeJson(path.join(dir, `${context.jobId}.json`), result);
        await withRetry(() => context.api.videoPosted(agentId, videoId, issueKey), { attempts: 3, baseMs: 500 }).catch((e: unknown) => {
          context.say(`video: could not tell the hub the video was attached: ${e instanceof Error ? e.message : String(e)}`);
        });
        return result;
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    }
  };
}
