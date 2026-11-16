import { type RecordedEvent, RRWEB_FULL_SNAPSHOT, RRWEB_META } from "../protocol.ts";
import { LAYER_ATTRIBUTE } from "./layer.ts";

/**
 * rrweb in the frame: a session recording while the shell says one is running, posted to the shell in batches, and a
 * one-off `[Meta, FullSnapshot]` of the page when a comment is made. rrweb's recorder is one per page, so both go
 * through one `emit`: a snapshot taken mid-recording is a `takeFullSnapshot` that also lands in the recording, which
 * replays a full snapshot mid-stream as a fresh page.
 */

export interface RecordOptions {
  emit: (event: RecordedEvent) => void;
  maskAllInputs: boolean;
  maskInputOptions: { password: boolean };
  blockSelector: string;
  sampling?: Record<string, unknown>;
  recordCanvas?: boolean;
  collectFonts?: boolean;
}

/** The part of `@rrweb/record`'s `record` the widget uses, so a test can stand in for it. */
export interface RecordFunction {
  (options: RecordOptions): (() => void) | undefined;
  takeFullSnapshot: (isCheckout?: boolean) => void;
}

export interface Recorder {
  start: (maskInputs: boolean) => void;
  stop: () => void;
  /** Posts whatever is buffered at once, as the page is about to go. */
  flush: () => void;
  snapshot: (maskInputs: boolean) => RecordedEvent[];
  recording: () => boolean;
}

/** How often buffered events go to the shell while recording. */
export const BATCH_MS = 2000;

/** Never recorded: an element the prototype marks, and the widget's own layer. */
export const BLOCK_SELECTOR = `[data-feedback-mask], [${LAYER_ATTRIBUTE}]`;

const SAMPLING = { mousemove: 100, scroll: 150, media: 800, input: "last" };

export function createRecorder(record: RecordFunction, post: (events: RecordedEvent[]) => void): Recorder {
  let stopRecording: (() => void) | undefined;
  let buffer: RecordedEvent[] = [];
  let capture: RecordedEvent[] | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const emit = (event: RecordedEvent) => {
    if (capture !== undefined && (event.type === RRWEB_META || event.type === RRWEB_FULL_SNAPSHOT)) {
      capture.push(event);
    }
    if (stopRecording !== undefined || timer !== undefined) {
      buffer.push(event);
    }
  };
  const options = (maskInputs: boolean): RecordOptions => ({
    emit,
    maskAllInputs: maskInputs,
    maskInputOptions: { password: true },
    blockSelector: BLOCK_SELECTOR,
    sampling: SAMPLING,
    recordCanvas: false,
    collectFonts: false
  });
  const flush = () => {
    if (buffer.length > 0) {
      const batch = buffer;
      buffer = [];
      post(batch);
    }
  };

  return {
    start: (maskInputs) => {
      if (timer !== undefined) {
        return;
      }
      timer = setInterval(flush, BATCH_MS);
      stopRecording = record(options(maskInputs));
    },
    stop: () => {
      stopRecording?.();
      stopRecording = undefined;
      clearInterval(timer);
      timer = undefined;
      flush();
    },
    flush,
    snapshot: (maskInputs) => {
      capture = [];
      try {
        if (timer !== undefined) {
          record.takeFullSnapshot(false);
        } else {
          record(options(maskInputs))?.();
        }
        return capture;
      } finally {
        capture = undefined;
      }
    },
    recording: () => timer !== undefined
  };
}
