"use client";

import type { WidgetAnchor } from "@/feedback/protocol";
import type { FeedbackRecordingView } from "@/feedback/recording-store";
import type { FeedbackCommentView, FeedbackThreadView } from "@/feedback/thread-store";

/**
 * The review shell's calls: to the hub's `/api/ui/feedback/review/{token}/…` routes, same-origin with the session
 * cookie, and straight to Blob Storage with the write-only URLs those hand back. Every refusal comes back as a
 * `ReviewRequestFailed` carrying the route's own words.
 */

export class ReviewRequestFailed extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ReviewRequestFailed";
    this.status = status;
  }
}

export interface Person {
  oid: string;
  name: string;
}

export interface NewThread {
  pagePath: string;
  anchor: WidgetAnchor;
  body: string;
  snapshot: boolean;
  recording?: { id: string; offsetMs: number };
}

export interface ReviewApi {
  threads: (pagePath: string) => Promise<FeedbackThreadView[]>;
  createThread: (input: NewThread) => Promise<{ thread: FeedbackThreadView; snapshotUrl: string | null }>;
  reply: (threadId: string, body: string) => Promise<FeedbackCommentView>;
  setStatus: (threadId: string, status: "open" | "resolved") => Promise<FeedbackThreadView>;
  people: () => Promise<Person[]>;
  startRecording: () => Promise<FeedbackRecordingView>;
  requestUpload: (
    recordingId: string,
    segment: { kind: "audio" | "replay"; seq: number; offsetMs: number; bytes: number; pagePath?: string }
  ) => Promise<{ url: string; segmentId: string }>;
  completeRecording: (recordingId: string, durationMs: number) => Promise<FeedbackRecordingView>;
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      credentials: "same-origin",
      mode: "same-origin",
      headers: init.body === undefined ? init.headers : { "content-type": "application/json", ...init.headers }
    });
  } catch {
    throw new ReviewRequestFailed(0, "The hub could not be reached. Check your connection and try again.");
  }
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : "Something went wrong. Try again.";
    throw new ReviewRequestFailed(response.status, message.charAt(0).toUpperCase() + message.slice(1));
  }
  return body as T;
}

function post(body: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}

export function reviewApi(token: string): ReviewApi {
  const base = `/api/ui/feedback/review/${encodeURIComponent(token)}`;
  return {
    threads: async (pagePath) => (await call<{ threads: FeedbackThreadView[] }>(`${base}/threads?${new URLSearchParams({ page_path: pagePath })}`)).threads,
    createThread: async (input) => {
      const created = await call<{ thread: FeedbackThreadView; snapshot_url: string | null }>(
        `${base}/threads`,
        post({
          page_path: input.pagePath,
          anchor: input.anchor,
          body: input.body,
          snapshot: input.snapshot,
          ...(input.recording === undefined ? {} : { recording_id: input.recording.id, offset_ms: input.recording.offsetMs })
        })
      );
      return { thread: created.thread, snapshotUrl: created.snapshot_url };
    },
    reply: async (threadId, body) =>
      (await call<{ comment: FeedbackCommentView }>(`${base}/threads/${encodeURIComponent(threadId)}/comments`, post({ body }))).comment,
    setStatus: async (threadId, status) =>
      (await call<{ thread: FeedbackThreadView }>(`${base}/threads/${encodeURIComponent(threadId)}`, { method: "PATCH", body: JSON.stringify({ status }) }))
        .thread,
    people: async () => (await call<{ people: Person[] }>(`${base}/people`)).people,
    startRecording: async () => (await call<{ recording: FeedbackRecordingView }>(`${base}/recordings`, post({}))).recording,
    requestUpload: async (recordingId, segment) => {
      const answer = await call<{ url: string; segment_id: string }>(
        `${base}/recordings/${encodeURIComponent(recordingId)}/uploads`,
        post({
          kind: segment.kind,
          seq: segment.seq,
          offset_ms: segment.offsetMs,
          bytes: segment.bytes,
          ...(segment.pagePath === undefined ? {} : { page_path: segment.pagePath })
        })
      );
      return { url: answer.url, segmentId: answer.segment_id };
    },
    completeRecording: async (recordingId, durationMs) =>
      (await call<{ recording: FeedbackRecordingView }>(`${base}/recordings/${encodeURIComponent(recordingId)}/complete`, post({ duration_ms: durationMs })))
        .recording
  };
}

/** `value` as JSON, gzipped in the browser, which is how snapshots and replay segments are stored (`.json.gz`). */
export async function gzipJson(value: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const stream = (new Response(JSON.stringify(value)).body as ReadableStream<BufferSource>).pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** How long to wait before each retry of a failed upload. */
export const RETRY_DELAYS_MS = [1000, 3000, 9000] as const;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Storage did not take a blob. Always worth another try: a fresh URL mends an expired one. */
export class UploadFailed extends Error {
  constructor(status: number) {
    super(`storage answered ${status}`);
    this.name = "UploadFailed";
  }
}

/** Puts one blob to its write-only URL, once. */
export async function putBlob(url: string, body: Blob | Uint8Array<ArrayBuffer>, contentType: string): Promise<void> {
  const response = await fetch(url, { method: "PUT", body, headers: { "x-ms-blob-type": "BlockBlob", "content-type": contentType } });
  if (!response.ok) {
    throw new UploadFailed(response.status);
  }
}

/** Whether a failure could go differently next time: anything but the hub refusing the request itself. */
function retryable(error: unknown): boolean {
  return !(error instanceof ReviewRequestFailed) || error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
}

/** Runs `work`, and again after each of `RETRY_DELAYS_MS` while it fails in a way that might not fail again. */
export async function withRetries<T>(work: () => Promise<T>, wait: (ms: number) => Promise<void> = sleep): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !retryable(error)) {
        throw error;
      }
      await wait(delay);
    }
  }
}
