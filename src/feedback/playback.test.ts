import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  clockText,
  gunzipJson,
  hasDrifted,
  type LoadedReplaySegment,
  pageBands,
  pagesVisited,
  playbackClock,
  recordingLength,
  recordingStart,
  recordingTime,
  replayEvents,
  replayOffset,
  type SegmentRef,
  segmentsOf,
  virtualClock
} from "./playback.ts";

const T0 = 1_700_000_000_000;

function segment(seq: number, offsetMs: number, timestamps: number[], pagePath: string | null = "/start"): LoadedReplaySegment {
  return { seq, offsetMs, pagePath, events: timestamps.map((timestamp, index) => ({ type: index === 0 ? 4 : 3, timestamp })) };
}

describe("segmentsOf", () => {
  it("should keep one kind of segment, in the order it was recorded", () => {
    const segments: SegmentRef[] = [
      { kind: "replay", seq: 1, offsetMs: 10_000, pagePath: "/b" },
      { kind: "audio", seq: 0, offsetMs: 0, pagePath: null },
      { kind: "replay", seq: 0, offsetMs: 0, pagePath: "/a" }
    ];

    expect(segmentsOf(segments, "replay").map((s) => s.seq)).toEqual([0, 1]);
    expect(segmentsOf(segments, "audio")).toHaveLength(1);
  });
});

describe("replayEvents", () => {
  it("should put every segment's events in time order whatever order the segments came in", () => {
    const events = replayEvents([segment(1, 2_000, [T0 + 2_000, T0 + 2_500]), segment(0, 0, [T0, T0 + 900])]);

    expect(events.map((event) => event.timestamp - T0)).toEqual([0, 900, 2_000, 2_500]);
  });

  it("should keep events stamped with one millisecond in the order they were recorded", () => {
    const events = replayEvents([
      {
        seq: 0,
        offsetMs: 0,
        pagePath: "/",
        events: [
          { type: 4, timestamp: T0 },
          { type: 2, timestamp: T0 }
        ]
      }
    ]);

    expect(events.map((event) => event.type)).toEqual([4, 2]);
  });
});

describe("recordingStart", () => {
  it("should take the recording's start from the first segment's first event less its offset", () => {
    // The page loaded 1.2 s after the microphone started.
    expect(recordingStart([segment(1, 9_000, [T0 + 9_000]), segment(0, 1_200, [T0 + 1_250, T0 + 1_200])])).toBe(T0);
  });

  it("should skip a segment with no events, and answer null when none has any", () => {
    expect(recordingStart([segment(0, 0, []), segment(1, 500, [T0 + 500])])).toBe(T0);
    expect(recordingStart([segment(0, 0, [])])).toBeNull();
  });
});

describe("the audio and replay clocks", () => {
  // The replay's first event came 1.2 s into the recording.
  const clock = { t0: T0, firstEvent: T0 + 1_200 };

  it("should map a point on the audio to the replayer's offset from its first event", () => {
    expect(replayOffset(clock, 5_000)).toBe(3_800);
    expect(recordingTime(clock, 3_800)).toBe(5_000);
  });

  it("should hold the replayer at its start while the audio is before its first event", () => {
    expect(replayOffset(clock, 400)).toBe(0);
  });

  it("should give no clock when there is no replay or no start", () => {
    expect(playbackClock([], T0)).toBeNull();
    expect(playbackClock([{ type: 4, timestamp: T0 + 5 }], null)).toBeNull();
    expect(playbackClock([{ type: 4, timestamp: T0 + 5 }], T0)).toEqual({ t0: T0, firstEvent: T0 + 5 });
  });

  it("should count the replayer as drifted only past 250 ms either way", () => {
    expect(hasDrifted(1_000, 1_250)).toBe(false);
    expect(hasDrifted(1_000, 1_251)).toBe(true);
    expect(hasDrifted(1_000, 749)).toBe(true);
  });
});

describe("pageBands", () => {
  const segments: SegmentRef[] = [
    { kind: "audio", seq: 0, offsetMs: 0, pagePath: null },
    { kind: "replay", seq: 0, offsetMs: 0, pagePath: "/start" },
    { kind: "replay", seq: 1, offsetMs: 10_000, pagePath: "/start" },
    { kind: "replay", seq: 2, offsetMs: 14_000, pagePath: "/details" },
    { kind: "replay", seq: 3, offsetMs: 20_000, pagePath: null },
    { kind: "replay", seq: 4, offsetMs: 25_000, pagePath: "/start" }
  ];

  it("should make one band per run of segments on one page, each ending where the next begins", () => {
    expect(pageBands(segments, 30_000)).toEqual([
      { pagePath: "/start", startMs: 0, endMs: 14_000 },
      { pagePath: "/details", startMs: 14_000, endMs: 25_000 },
      { pagePath: "/start", startMs: 25_000, endMs: 30_000 }
    ]);
  });

  it("should drop a band that starts after the recording ends", () => {
    expect(pageBands(segments, 20_000).map((band) => band.pagePath)).toEqual(["/start", "/details"]);
  });

  it("should list the pages visited once each in the order first reached", () => {
    expect(pagesVisited(segments)).toEqual(["/start", "/details"]);
  });
});

describe("recordingLength", () => {
  const events = [
    { type: 4, timestamp: T0 + 1_000 },
    { type: 3, timestamp: T0 + 42_000 }
  ];

  it("should take the length the recording was stopped at when it has one", () => {
    expect(recordingLength(60_000, events, T0, 12)).toBe(60_000);
  });

  it("should otherwise reach as far as the replay or the audio does", () => {
    expect(recordingLength(null, events, T0, 12)).toBe(42_000);
    expect(recordingLength(0, events, T0, 50)).toBe(50_000);
    expect(recordingLength(null, [], null, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("clockText", () => {
  it.each([
    [0, "0:00"],
    [65_400, "1:05"],
    [3_723_000, "1:02:03"],
    [-5, "0:00"]
  ])("should show %d ms as %s", (ms, text) => {
    expect(clockText(ms)).toBe(text);
  });
});

describe("virtualClock", () => {
  it("should run at its rate while playing, and hold still while paused", () => {
    let at = 0;
    const clock = virtualClock(10_000, () => at);

    clock.play();
    at = 1_000;
    expect(clock.time()).toBe(1_000);
    clock.setRate(2);
    at = 2_000;
    expect(clock.time()).toBe(3_000);
    clock.pause();
    at = 5_000;
    expect(clock.time()).toBe(3_000);
    expect(clock.playing()).toBe(false);
  });

  it("should seek within the recording, carry on playing from there, and stop at its end", () => {
    let at = 0;
    const clock = virtualClock(10_000, () => at);

    clock.seek(-50);
    expect(clock.time()).toBe(0);
    clock.play();
    clock.seek(9_000);
    at = 500;
    expect(clock.time()).toBe(9_500);
    expect(clock.playing()).toBe(true);
    at = 5_000;
    expect(clock.time()).toBe(10_000);
    expect(clock.playing()).toBe(false);
  });

  it("should start again from the beginning when played at its end", () => {
    let at = 0;
    const clock = virtualClock(1_000, () => at);
    clock.seek(1_000);

    clock.play();
    at = 100;

    expect(clock.time()).toBe(100);
  });

  it("should change rate while paused without moving", () => {
    const clock = virtualClock(1_000, () => 0);
    clock.seek(300);
    clock.setRate(1.5);
    expect(clock.time()).toBe(300);
  });
});

describe("gunzipJson", () => {
  it("should read a gzipped JSON array of events", async () => {
    const bytes = gzipSync(JSON.stringify([{ type: 4, timestamp: 1 }]));

    expect(await gunzipJson(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))).toEqual([{ type: 4, timestamp: 1 }]);
  });

  it("should refuse anything that is not an array", async () => {
    const bytes = gzipSync(JSON.stringify({ type: 4 }));

    await expect(gunzipJson(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))).rejects.toThrow("JSON array");
  });
});
