"use client";

import { MAX_RECORDING_MS } from "@/feedback/limits";
import type { RecordedEvent } from "@/feedback/protocol";
import { gzipJson, putBlob, type ReviewApi, withRetries } from "./reviewClient";

/**
 * One recording in the review shell: the microphone in 10-second Opus/WebM slices and the widget's rrweb events in
 * 10-second gzipped chunks, each uploaded as a numbered segment as soon as it is ready, one at a time and in order.
 *
 * Timing, which the developer UI's player relies on:
 * - `t0` is the wall-clock time the `MediaRecorder` actually started, so audio time 0 is `t0`. It is taken in the shell
 *   and never sent; every offset is measured from it.
 * - An audio segment's `offset_ms` is when its slice began, `t0`-relative. Only slice 0 carries the WebM header, so the
 *   player concatenates every audio segment in `seq` order into one blob.
 * - A replay segment's `offset_ms` is its first event's `timestamp - t0` (the frame and the shell share the browser's
 *   clock). The player places any event at audio time `event.timestamp - (firstEvent.timestamp - offset_ms)`, which
 *   is `event.timestamp - t0`. Each segment holds one page's events (`page_path`), and every page load in the frame
 *   starts with a fresh Meta and FullSnapshot.
 */

export const AUDIO_SLICE_MS = 10_000;
export const REPLAY_CHUNK_MS = 10_000;
/** How long after the widget is told to stop its last batch is waited for. */
export const STOP_GRACE_MS = 300;
const AUDIO_TYPE = "audio/webm;codecs=opus";

/** The part of `MediaRecorder` the session uses, so a test can stand in for it. */
export interface MediaRecorderLike {
  mimeType: string;
  start: (timeslice: number) => void;
  stop: () => void;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstart: (() => void) | null;
  onstop: (() => void) | null;
}

export function browserRecorder(stream: MediaStream): MediaRecorderLike {
  const options = typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(AUDIO_TYPE) ? { mimeType: AUDIO_TYPE } : undefined;
  return new MediaRecorder(stream, options) as unknown as MediaRecorderLike;
}

export interface RecordingDependencies {
  api: Pick<ReviewApi, "startRecording" | "requestUpload" | "completeRecording">;
  stream: MediaStream;
  createRecorder?: (stream: MediaStream) => MediaRecorderLike;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  /** Called once for each segment that could not be saved after every retry; the recording carries on. */
  onUploadError: (message: string) => void;
}

export interface RecordingSession {
  recordingId: string;
  /** Milliseconds since `t0`, for a thread made during the recording. */
  elapsed: () => number;
  addReplay: (pagePath: string, events: readonly RecordedEvent[]) => void;
  /** Stops the microphone, uploads what is left and completes the recording. */
  stop: () => Promise<void>;
}

type Segment =
  | { kind: "audio"; seq: number; offsetMs: number; blob: Blob }
  | { kind: "replay"; seq: number; offsetMs: number; pagePath: string; events: RecordedEvent[] };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function clampOffset(ms: number): number {
  return Math.min(MAX_RECORDING_MS, Math.max(0, Math.round(ms)));
}

export async function startRecordingSession(deps: RecordingDependencies): Promise<RecordingSession> {
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? sleep;
  const recording = await deps.api.startRecording();
  const recorder = (deps.createRecorder ?? browserRecorder)(deps.stream);

  let t0 = now();
  let sliceStart = 0;
  let audioSeq = 0;
  let replaySeq = 0;
  let replay: RecordedEvent[] = [];
  let replayPath = "";
  let queue: Promise<void> = Promise.resolve();
  let failed = false;

  const upload = async (segment: Segment) => {
    const body = segment.kind === "audio" ? segment.blob : await gzipJson(segment.events);
    const bytes = body instanceof Blob ? body.size : body.byteLength;
    await withRetries(async () => {
      const { url } = await deps.api.requestUpload(recording.id, {
        kind: segment.kind,
        seq: segment.seq,
        offsetMs: segment.offsetMs,
        bytes,
        ...(segment.kind === "replay" ? { pagePath: segment.pagePath } : {})
      });
      await putBlob(url, body, segment.kind === "audio" ? recorder.mimeType || "audio/webm" : "application/json");
    }, wait);
  };
  const enqueue = (segment: Segment) => {
    queue = queue.then(() =>
      upload(segment).catch(() => {
        if (!failed) {
          failed = true;
          deps.onUploadError("Part of this recording could not be saved. It carries on recording.");
        }
      })
    );
  };
  const flushReplay = () => {
    const first = replay[0];
    if (first === undefined) {
      return;
    }
    enqueue({ kind: "replay", seq: replaySeq++, offsetMs: clampOffset(first.timestamp - t0), pagePath: replayPath, events: replay });
    replay = [];
  };

  const started = new Promise<number>((resolve) => {
    recorder.onstart = () => resolve(now());
  });
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  recorder.ondataavailable = (event) => {
    const at = now() - t0;
    if (event.data.size > 0) {
      enqueue({ kind: "audio", seq: audioSeq++, offsetMs: clampOffset(sliceStart), blob: event.data });
    }
    sliceStart = at;
  };
  recorder.start(AUDIO_SLICE_MS);
  t0 = await started;
  const timer = setInterval(flushReplay, REPLAY_CHUNK_MS);

  return {
    recordingId: recording.id,
    elapsed: () => clampOffset(now() - t0),
    addReplay: (pagePath, events) => {
      if (events.length === 0) {
        return;
      }
      if (replay.length > 0 && pagePath !== replayPath) {
        flushReplay();
      }
      replayPath = pagePath;
      replay.push(...events);
    },
    stop: async () => {
      clearInterval(timer);
      recorder.stop();
      await stopped;
      await wait(STOP_GRACE_MS);
      for (const track of deps.stream.getTracks()) {
        track.stop();
      }
      flushReplay();
      await queue;
      await withRetries(() => deps.api.completeRecording(recording.id, clampOffset(now() - t0)), wait);
    }
  };
}
