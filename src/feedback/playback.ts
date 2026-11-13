/**
 * The recorder-mode player's arithmetic, kept pure so it is tested apart from the browser: putting a recording's
 * segments back together, and moving between the audio's clock and the replay's.
 *
 * Every replay segment is stamped with `offset_ms`, how far into the recording its first event came, where the
 * recording starts when the audio does. So each segment names the same wall-clock start, `t0`: its first event's
 * `timestamp` less its offset. The audio is the master clock; an event plays at `event.timestamp - t0` on it, and the
 * replayer, which counts from its own first event, is asked for that less where its first event falls.
 */

/** One rrweb event as far as the player needs it: rrweb's own type stays with the replayer. */
export interface TimedEvent {
  type: number;
  timestamp: number;
}

export interface SegmentRef {
  kind: "audio" | "replay";
  seq: number;
  offsetMs: number;
  pagePath: string | null;
}

export interface LoadedReplaySegment<E extends TimedEvent = TimedEvent> {
  seq: number;
  offsetMs: number;
  pagePath: string | null;
  events: readonly E[];
}

const bySeq = (a: { seq: number }, b: { seq: number }): number => a.seq - b.seq;
const byTimestamp = (a: TimedEvent, b: TimedEvent): number => a.timestamp - b.timestamp;

/** The segments of one kind, in the order they were recorded. */
export function segmentsOf<S extends SegmentRef>(segments: readonly S[], kind: SegmentRef["kind"]): S[] {
  return segments.filter((segment) => segment.kind === kind).sort(bySeq);
}

/**
 * Every replay event of the recording in time order. The sort is stable, so events a page stamped with one
 * millisecond keep the order they were recorded in, which a Meta before its FullSnapshot depends on.
 */
export function replayEvents<E extends TimedEvent>(segments: readonly LoadedReplaySegment<E>[]): E[] {
  return [...segments]
    .sort(bySeq)
    .flatMap((segment) => segment.events)
    .sort(byTimestamp);
}

/** The recording's wall-clock start, from the first replay segment that has an event; `null` when none has. */
export function recordingStart(segments: readonly LoadedReplaySegment[]): number | null {
  const first = [...segments].sort(bySeq).find((segment) => segment.events.length > 0);
  if (first === undefined) {
    return null;
  }
  const earliest = first.events.reduce((min, event) => Math.min(min, event.timestamp), Number.POSITIVE_INFINITY);
  return earliest - first.offsetMs;
}

/** The two clocks of one recording: where the replay's first event is on the recording's, both from `t0`. */
export interface PlaybackClock {
  /** Wall-clock milliseconds at the start of the recording. */
  t0: number;
  /** Wall-clock milliseconds of the replayer's first event, which is its own zero. */
  firstEvent: number;
}

export function playbackClock(events: readonly TimedEvent[], t0: number | null): PlaybackClock | null {
  const first = events[0];
  if (first === undefined || t0 === null) {
    return null;
  }
  return { t0, firstEvent: first.timestamp };
}

/** The replayer's offset for a point on the recording's clock, never before its first event. */
export function replayOffset(clock: PlaybackClock, recordingMs: number): number {
  return Math.max(0, recordingMs + clock.t0 - clock.firstEvent);
}

/** The point on the recording's clock for a replayer offset. */
export function recordingTime(clock: PlaybackClock, offsetMs: number): number {
  return offsetMs + clock.firstEvent - clock.t0;
}

/** How far the replayer may wander from the audio before it is put back. */
export const DRIFT_MS = 250;

export function hasDrifted(expectedOffset: number, actualOffset: number): boolean {
  return Math.abs(expectedOffset - actualOffset) > DRIFT_MS;
}

/** A stretch of the timeline spent on one page. */
export interface PageBand {
  pagePath: string;
  startMs: number;
  endMs: number;
}

/**
 * The pages visited, as bands across the recording: each replay segment starts where its offset says, a run of
 * segments on one page is one band, and each band ends where the next begins or the recording does.
 */
export function pageBands(segments: readonly SegmentRef[], durationMs: number): PageBand[] {
  const bands: PageBand[] = [];
  for (const segment of segmentsOf(segments, "replay")) {
    if (segment.pagePath === null) {
      continue;
    }
    const last = bands.at(-1);
    if (last?.pagePath === segment.pagePath) {
      continue;
    }
    const startMs = Math.min(segment.offsetMs, durationMs);
    if (last !== undefined) {
      last.endMs = startMs;
    }
    bands.push({ pagePath: segment.pagePath, startMs, endMs: durationMs });
  }
  return bands.filter((band) => band.endMs > band.startMs);
}

/** Distinct pages of a recording, in the order they were first visited. */
export function pagesVisited(segments: readonly SegmentRef[]): string[] {
  const seen: string[] = [];
  for (const segment of segmentsOf(segments, "replay")) {
    if (segment.pagePath !== null && !seen.includes(segment.pagePath)) {
      seen.push(segment.pagePath);
    }
  }
  return seen;
}

/**
 * How long the recording runs: the length it was stopped at when there is one, otherwise as far as its audio or its
 * replay reaches. A MediaRecorder file reports no duration of its own, so the audio element's is only a last resort.
 */
export function recordingLength(durationMs: number | null, events: readonly TimedEvent[], t0: number | null, audioSeconds: number): number {
  if (durationMs !== null && durationMs > 0) {
    return durationMs;
  }
  const last = events.at(-1);
  const replayEnd = last === undefined || t0 === null ? 0 : last.timestamp - t0;
  const audioEnd = Number.isFinite(audioSeconds) ? audioSeconds * 1000 : 0;
  return Math.max(replayEnd, audioEnd, 0);
}

/** `m:ss`, or `h:mm:ss` past the hour. */
export function clockText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/**
 * A clock for a recording with no audio: the same play, pause, seek and rate as an `<audio>` gives, counted from
 * `now`. Stops at `durationMs`.
 */
export interface VirtualClock {
  time: () => number;
  playing: () => boolean;
  play: () => void;
  pause: () => void;
  seek: (ms: number) => void;
  setRate: (rate: number) => void;
}

export function virtualClock(durationMs: number, now: () => number): VirtualClock {
  let base = 0;
  let startedAt: number | null = null;
  let rate = 1;
  const time = (): number => Math.min(durationMs, startedAt === null ? base : base + (now() - startedAt) * rate);
  return {
    time,
    playing: () => startedAt !== null && time() < durationMs,
    play: () => {
      if (startedAt === null) {
        if (base >= durationMs) {
          base = 0;
        }
        startedAt = now();
      }
    },
    pause: () => {
      base = time();
      startedAt = null;
    },
    seek: (ms) => {
      base = Math.max(0, Math.min(durationMs, ms));
      if (startedAt !== null) {
        startedAt = now();
      }
    },
    setRate: (next) => {
      base = time();
      if (startedAt !== null) {
        startedAt = now();
      }
      rate = next;
    }
  };
}

/** Bytes gunzipped and parsed as the JSON array of events a replay segment or snapshot is stored as. */
export async function gunzipJson<T>(bytes: ArrayBuffer): Promise<T[]> {
  const stream = (new Response(bytes).body as ReadableStream<Uint8Array<ArrayBuffer>>).pipeThrough(new DecompressionStream("gzip"));
  const parsed: unknown = JSON.parse(await new Response(stream).text());
  if (!Array.isArray(parsed)) {
    throw new Error("a recorded segment is a JSON array of events");
  }
  return parsed as T[];
}
