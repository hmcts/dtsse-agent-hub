"use client";

import type { Replayer } from "@rrweb/replay";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { MentionPerson } from "@/components/feedback/MentionInput";
import { ThreadCard } from "@/components/feedback/ThreadCard";
import {
  clockText,
  gunzipJson,
  hasDrifted,
  type LoadedReplaySegment,
  type PlaybackClock,
  pageBands,
  playbackClock,
  recordingLength,
  recordingStart,
  replayEvents,
  replayOffset,
  segmentsOf,
  type VirtualClock,
  virtualClock
} from "@/feedback/playback";
import type { FeedbackRecordingDetail, FeedbackSegmentView } from "@/feedback/recording-store";
import type { FeedbackThreadView } from "@/feedback/thread-store";
import type { ThreadHandlers } from "./CommentsView";
import { SECONDARY } from "./look";

/**
 * A reviewer's recording played back: their voice, and their screen rebuilt by rrweb beside it, in step. The audio is
 * the clock; the replayer is driven from it and put back whenever it drifts more than `DRIFT_MS`. A recording with no
 * audio runs on a clock of its own, and one with no replay is just its audio. The timeline shows which page they were
 * on when, and a marker for each comment they made, which seeks there and shows the comment.
 *
 * The replayer's frame is sandboxed with scripts off, as the snapshot's is.
 */

type ReplayEvent = Exclude<ConstructorParameters<typeof Replayer>[0][number], string>;

type SegmentWithUrl = FeedbackSegmentView & { url: string };

type Loaded = { phase: "loading" } | { phase: "failed"; message: string } | { phase: "ready"; audio: string | null; events: ReplayEvent[]; t0: number | null };

export const SKIP_MS = 5_000;
export const SPEEDS = [1, 1.5, 2] as const;

async function bytesOf(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("a part of the recording could not be downloaded");
  }
  return await response.arrayBuffer();
}

/** Every segment, downloaded: the audio as one file, since only its first chunk carries the WebM header, and the replay as one list. */
export async function loadRecording(projectId: string, recordingId: string): Promise<{ audio: Blob | null; events: ReplayEvent[]; t0: number | null }> {
  const answer = await fetch(`/api/ui/feedback/projects/${projectId}/recordings/${recordingId}`);
  if (!answer.ok) {
    throw new Error("the recording could not be read");
  }
  const { recording } = (await answer.json()) as { recording: { segments: SegmentWithUrl[] } };
  const audio = segmentsOf(recording.segments, "audio");
  const replay = segmentsOf(recording.segments, "replay");
  const [audioParts, replayParts] = await Promise.all([
    Promise.all(audio.map((segment) => bytesOf(segment.url))),
    Promise.all(
      replay.map(
        async (segment): Promise<LoadedReplaySegment<ReplayEvent>> => ({
          seq: segment.seq,
          offsetMs: segment.offsetMs,
          pagePath: segment.pagePath,
          events: await gunzipJson<ReplayEvent>(await bytesOf(segment.url))
        })
      )
    )
  ]);
  return {
    audio: audioParts.length === 0 ? null : new Blob(audioParts, { type: "audio/webm" }),
    events: replayEvents(replayParts),
    t0: recordingStart(replayParts)
  };
}

function isField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

export function RecordingPlayer({
  projectId,
  recording,
  threads,
  people,
  handlers,
  load = loadRecording
}: Readonly<{
  projectId: string;
  recording: FeedbackRecordingDetail;
  threads: readonly FeedbackThreadView[];
  people: readonly MentionPerson[];
  handlers: ThreadHandlers;
  load?: typeof loadRecording;
}>) {
  const ids = useId();
  const [loaded, setLoaded] = useState<Loaded>({ phase: "loading" });
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [shown, setShown] = useState<string | null>(null);
  const [audioSeconds, setAudioSeconds] = useState(Number.NaN);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  const audio = useRef<HTMLAudioElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const replayer = useRef<Replayer | null>(null);

  useEffect(() => {
    let live = true;
    let url: string | null = null;
    load(projectId, recording.id)
      .then((result) => {
        if (!live) {
          return;
        }
        url = result.audio === null ? null : URL.createObjectURL(result.audio);
        setLoaded({ phase: "ready", audio: url, events: result.events, t0: result.t0 });
      })
      .catch((error: unknown) => {
        if (live) {
          setLoaded({ phase: "failed", message: error instanceof Error ? error.message : "the recording could not be loaded" });
        }
      });
    return () => {
      live = false;
      if (url !== null) {
        URL.revokeObjectURL(url);
      }
    };
  }, [load, projectId, recording.id]);

  const ready = loaded.phase === "ready" ? loaded : null;
  const events = ready?.events ?? [];
  const duration = recordingLength(recording.durationMs, events, ready?.t0 ?? null, audioSeconds);
  const clock: PlaybackClock | null = useMemo(() => (ready === null ? null : playbackClock(ready.events, ready.t0)), [ready]);
  const hasAudio = ready?.audio != null;
  const virtual = useMemo<VirtualClock | null>(
    () => (ready === null || hasAudio ? null : virtualClock(duration, () => performance.now())),
    [ready, hasAudio, duration]
  );

  const now = useCallback((): number => {
    if (audio.current !== null && hasAudio) {
      return audio.current.currentTime * 1000;
    }
    return virtual?.time() ?? 0;
  }, [hasAudio, virtual]);

  /** Puts the replayer where the clock is, playing or paused as the clock is. */
  const follow = useCallback(
    (running: boolean) => {
      const player = replayer.current;
      if (player === null || clock === null) {
        return;
      }
      const offset = replayOffset(clock, now());
      if (running) {
        player.play(offset);
      } else {
        player.pause(offset);
      }
    },
    [clock, now]
  );

  useEffect(() => {
    const root = stage.current;
    if (ready === null || ready.events.length < 2 || root === null) {
      return;
    }
    let live = true;
    let built: Replayer | undefined;
    void import("@rrweb/replay").then(({ Replayer }) => {
      if (!live) {
        return;
      }
      root.replaceChildren();
      built = new Replayer(ready.events, {
        root,
        UNSAFE_replayCanvas: false,
        mouseTail: false,
        showWarning: false,
        triggerFocus: false,
        skipInactive: false
      });
      built.on("resize", (dimension) => setSize(dimension as { width: number; height: number }));
      replayer.current = built;
      follow(false);
    });
    return () => {
      live = false;
      built?.destroy();
      replayer.current = null;
    };
  }, [ready, follow]);

  useEffect(() => {
    const element = box.current;
    if (element === null) {
      return;
    }
    setBoxWidth(element.clientWidth);
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => setBoxWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The shown time follows the clock every frame while playing; the audio's own events fire too seldom for that.
  useEffect(() => {
    if (!playing) {
      return;
    }
    let frame = 0;
    const tick = () => {
      const at = now();
      setTime(at);
      if (virtual !== null && at >= duration) {
        virtual.pause();
        setPlaying(false);
        follow(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, now, virtual, duration, follow]);

  function play(): void {
    if (hasAudio && audio.current !== null) {
      void audio.current.play()?.catch(() => setPlaying(false));
    } else {
      virtual?.play();
      setPlaying(true);
      follow(true);
    }
  }

  function pause(): void {
    if (hasAudio && audio.current !== null) {
      audio.current.pause();
    } else {
      virtual?.pause();
      setPlaying(false);
      follow(false);
    }
  }

  function seek(ms: number): void {
    const to = Math.max(0, Math.min(duration, ms));
    if (hasAudio && audio.current !== null) {
      audio.current.currentTime = to / 1000;
    } else {
      virtual?.seek(to);
      follow(playing);
    }
    setTime(to);
  }

  function changeSpeed(next: number): void {
    setSpeed(next);
    if (audio.current !== null) {
      audio.current.playbackRate = next;
    }
    virtual?.setRate(next);
    replayer.current?.setConfig({ speed: next });
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (isField(event.target)) {
      return;
    }
    if (event.key === " " && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      if (playing) {
        pause();
      } else {
        play();
      }
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      seek(now() + (event.key === "ArrowRight" ? SKIP_MS : -SKIP_MS));
    }
  }

  const bands = pageBands(recording.segments, duration);
  const percent = (ms: number) => `${duration > 0 ? Math.min(100, (ms / duration) * 100) : 0}%`;
  const thread = threads.find((t) => t.id === shown);
  const scale = size === null || boxWidth === 0 ? 1 : Math.min(1, boxWidth / size.width);
  const onlyAudio = ready !== null && events.length < 2;

  return (
    <section aria-label="Recording player" className="flex flex-col gap-3" onKeyDown={onKeyDown}>
      {loaded.phase === "loading" ? (
        <p role="status" className="text-[13px] text-asst-muted">
          Loading the recording…
        </p>
      ) : null}
      {loaded.phase === "failed" ? (
        <p role="alert" className="text-[13px] text-asst-error">
          The recording could not be played: {loaded.message}.
        </p>
      ) : null}
      <div
        ref={box}
        className={`relative w-full overflow-hidden rounded-xl border border-asst-line bg-white ${onlyAudio || loaded.phase !== "ready" ? "hidden" : ""}`}
        style={{ height: size === null ? 360 : size.height * scale }}
      >
        <div
          ref={stage}
          aria-hidden="true"
          className="feedback-replay pointer-events-none absolute left-0 top-0 origin-top-left"
          style={{ transform: `scale(${scale})`, width: size?.width, height: size?.height }}
        />
      </div>
      {onlyAudio ? <p className="text-[13px] text-asst-muted">This recording has the reviewer's voice only, with no screen to show.</p> : null}
      {ready?.audio ? (
        // biome-ignore lint/a11y/useMediaCaption: a reviewer's spoken feedback has no transcript to caption it from.
        <audio
          ref={audio}
          src={ready.audio}
          preload="auto"
          onLoadedMetadata={(event) => setAudioSeconds(event.currentTarget.duration)}
          onPlay={() => {
            setPlaying(true);
            follow(true);
          }}
          onPause={() => {
            setPlaying(false);
            follow(false);
          }}
          onEnded={() => {
            setPlaying(false);
            follow(false);
          }}
          onSeeked={(event) => {
            setTime(event.currentTarget.currentTime * 1000);
            follow(!event.currentTarget.paused);
          }}
          onTimeUpdate={() => {
            const player = replayer.current;
            if (player !== null && clock !== null && playing && hasDrifted(replayOffset(clock, now()), player.getCurrentTime())) {
              follow(true);
            }
          }}
          className="hidden"
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={SECONDARY} disabled={ready === null} onClick={() => (playing ? pause() : play())}>
          {playing ? "Pause" : "Play"}
        </button>
        <button type="button" className={SECONDARY} disabled={ready === null} onClick={() => seek(now() - SKIP_MS)}>
          Back 5 seconds
        </button>
        <button type="button" className={SECONDARY} disabled={ready === null} onClick={() => seek(now() + SKIP_MS)}>
          Forward 5 seconds
        </button>
        <span className="text-[13px] tabular-nums text-asst-muted">
          <span className="sr-only">Position </span>
          {clockText(time)} / {clockText(duration)}
        </span>
        <fieldset className="ml-auto flex items-center gap-1 text-[13px]">
          <legend className="sr-only">Playback speed</legend>
          {SPEEDS.map((rate) => (
            <button
              key={rate}
              type="button"
              aria-pressed={speed === rate}
              onClick={() => changeSpeed(rate)}
              className={`rounded-md px-2 py-1 ${speed === rate ? "bg-asst-active font-semibold" : "hover:bg-asst-hover"}`}
            >
              {rate}×
            </button>
          ))}
        </fieldset>
      </div>

      <div className="flex flex-col gap-1">
        <div
          id={`${ids}-timeline`}
          role="slider"
          tabIndex={0}
          aria-label="Timeline"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration / 1000)}
          aria-valuenow={Math.round(time / 1000)}
          aria-valuetext={`${clockText(time)} of ${clockText(duration)}`}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            if (rect.width > 0) {
              seek(((event.clientX - rect.left) / rect.width) * duration);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              seek(event.key === "Home" ? 0 : duration);
            }
          }}
          className="relative h-9 w-full cursor-pointer overflow-hidden rounded-lg border border-asst-line bg-asst-field"
        >
          {bands.map((band, index) => (
            <div
              key={`${band.pagePath} ${band.startMs}`}
              title={band.pagePath}
              data-testid="page-band"
              className={`absolute inset-y-0 truncate border-r border-asst-line px-1.5 pt-0.5 text-[11px] text-asst-muted ${index % 2 === 0 ? "bg-asst-hover" : "bg-asst-raised"}`}
              style={{ left: percent(band.startMs), width: `calc(${percent(band.endMs - band.startMs)})` }}
            >
              {band.pagePath}
            </div>
          ))}
          <div aria-hidden="true" className="absolute inset-y-0 w-0.5 bg-asst-accent" style={{ left: percent(time) }} />
        </div>
        <div className="relative h-6 w-full">
          {recording.markers.map((marker) => {
            const author = threads.find((t) => t.id === marker.threadId)?.author.name ?? "a reviewer";
            return (
              <button
                key={marker.threadId}
                type="button"
                aria-label={`Comment by ${author} at ${clockText(marker.offsetMs)}`}
                aria-pressed={shown === marker.threadId}
                onClick={() => {
                  seek(marker.offsetMs);
                  setShown(marker.threadId);
                }}
                className="absolute top-0 flex h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full bg-asst-accent text-[10px] font-bold text-asst-ink"
                style={{ left: percent(marker.offsetMs) }}
              >
                <span aria-hidden="true">●</span>
              </button>
            );
          })}
        </div>
        <p className="text-xs text-asst-faint">Space plays and pauses; the arrow keys skip 5 seconds.</p>
      </div>

      {thread === undefined ? null : (
        <div className="max-w-md">
          <ThreadCard
            thread={thread}
            people={people}
            focused
            onReply={(body) => handlers.reply(thread.id, body)}
            onStatus={(status) => handlers.status(thread.id, status)}
          />
        </div>
      )}
    </section>
  );
}
