import { z } from "zod";
import { boundedArray } from "../agent-api/bounded-array.ts";
import { jsonbText } from "./deck.ts";

/**
 * A conversation's journey video as the hub keeps it. The recording is made by the session with the workspace's
 * `/cft-journey-video` skill and published with `agent-hub video put`: the MP4 goes straight to Blob Storage by a SAS
 * the hub signs, and what the panel shows beside it (captions, chapters, coverage and content mismatches) is kept
 * here. See "Journey videos" in docs/agent-api.md.
 */

/** The migration's CHECKs. A recording is 1.5–100 MB; the cap leaves room for a longer journey. */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
export const MAX_VIDEO_NAME = 200;
export const MAX_CAPTIONS = 100_000;
export const MAX_CHAPTERS = 200;
export const MAX_CHAPTER_TITLE = 200;
export const MAX_VIDEO_REPORT = 40_000;
export const MAX_COVERAGE_SUMMARY = 300;

/** Long enough to put a 200 MiB recording over a slow connection. */
export const VIDEO_UPLOAD_TTL_MS = 60 * 60_000;
/** Long enough to watch a long recording through, and for a pod to download it to attach it. */
export const VIDEO_READ_TTL_MS = 60 * 60_000;
/** An upload that was never finished is deleted, row and blob, this long after it began. */
export const STALE_UPLOAD_MS = 2 * 60 * 60_000;

export const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]{1,9}-\d{1,9}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isVideoId = (value: unknown): value is string => typeof value === "string" && UUID_RE.test(value);

export interface VideoChapter {
  /** Seconds from the start. */
  at: number;
  title: string;
}

const storable = (text: string): boolean => jsonbText(text) !== undefined;
const UNSTORABLE = "must not contain a NUL character or half of a surrogate pair";
const text = (max: number) => z.string().max(max).refine(storable, { message: UNSTORABLE });
const trimmed = (max: number) => z.string().trim().min(1).max(max).refine(storable, { message: UNSTORABLE });

export const jiraKey = z.string().regex(JIRA_KEY_RE, { message: "must be a Jira issue key such as HDPI-1234" });

/** The body of `POST …/video`. */
export const videoBeginBody = z.strictObject({
  name: trimmed(MAX_VIDEO_NAME),
  bytes: z.number().int().min(1).max(MAX_VIDEO_BYTES),
  captions: text(MAX_CAPTIONS).optional(),
  chapters: boundedArray(
    z.strictObject({
      at: z
        .number()
        .int()
        .min(0)
        .max(24 * 60 * 60),
      title: trimmed(MAX_CHAPTER_TITLE)
    }),
    MAX_CHAPTERS,
    {
      message: `at most ${MAX_CHAPTERS} chapters`
    }
  ),
  coverage: text(MAX_VIDEO_REPORT),
  coverage_summary: trimmed(MAX_COVERAGE_SUMMARY).optional(),
  content_mismatches: text(MAX_VIDEO_REPORT),
  jira_key: jiraKey.optional()
});

export type VideoBegin = z.output<typeof videoBeginBody>;

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

function firstIssue(error: z.ZodError): string {
  const [issue] = error.issues;
  if (issue === undefined) {
    return "the request body is not valid";
  }
  const [field, ...rest] = issue.path.map(String);
  return `${field ?? "body"}${rest.map((part) => `.${part}`).join("")} ${issue.message}`;
}

export function checkVideoBegin(value: unknown): Checked<VideoBegin> {
  const parsed = videoBeginBody.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }
  const { chapters } = parsed.data;
  for (let i = 1; i < chapters.length; i += 1) {
    if ((chapters[i] as VideoChapter).at < (chapters[i - 1] as VideoChapter).at) {
      return { ok: false, error: "chapters must be in time order" };
    }
  }
  return { ok: true, value: parsed.data };
}

export const videoPostedBody = z.strictObject({ issue_key: jiraKey });

export function checkVideoPosted(value: unknown): Checked<{ issue_key: string }> {
  const parsed = videoPostedBody.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: firstIssue(parsed.error) };
}

/** Where a conversation's blobs are: all under its id, so deleting the conversation's videos is deleting a prefix. */
export function videoPrefix(conversationId: string): string {
  return `${conversationId}/`;
}

export function videoPath(conversationId: string, videoId: string): string {
  return `${videoPrefix(conversationId)}${videoId}.mp4`;
}

/** The conversation and video a blob name is, or `undefined` for a name this hub did not make. */
export function parseVideoPath(name: string): { conversationId: string; videoId: string } | undefined {
  const match = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\.mp4$/i.exec(name);
  return match !== null && UUID_RE.test(match[1] as string) && UUID_RE.test(match[2] as string)
    ? { conversationId: (match[1] as string).toLowerCase(), videoId: (match[2] as string).toLowerCase() }
    : undefined;
}

/** A file name for the attached or downloaded recording: the name given, made safe, ending `.mp4`. */
export function videoFileName(name: string): string {
  const stem = name
    .replace(/\.mp4$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
  return `${stem === "" ? "journey-video" : stem}.mp4`;
}

export function formatStamp(seconds: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}
