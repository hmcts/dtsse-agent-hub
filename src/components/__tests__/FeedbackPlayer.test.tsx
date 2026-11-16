/**
 * @vitest-environment jsdom
 */
import { gzipSync } from "node:zlib";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadHandlers } from "@/components/feedback/dev/CommentsView";
import { loadRecording, RecordingPlayer } from "@/components/feedback/dev/RecordingPlayer";
import { RecordingView } from "@/components/feedback/dev/RecordingView";
import { ANN, project, recordingDetail, thread } from "./feedback-fixtures";

const players = vi.hoisted(() => ({
  built: [] as {
    calls: [string, number | undefined][];
    config: Record<string, unknown>;
    current: number;
    resize?: (size: unknown) => void;
    destroyed: boolean;
  }[]
}));

vi.mock("@rrweb/replay", () => ({
  Replayer: class {
    record: (typeof players.built)[number];
    constructor(_events: unknown[], config: Record<string, unknown>) {
      this.record = { calls: [], config, current: 0, destroyed: false };
      players.built.push(this.record);
    }
    on(_event: string, handler: (size: unknown) => void) {
      this.record.resize = handler;
      return this;
    }
    play(at?: number) {
      this.record.calls.push(["play", at]);
      this.record.current = at ?? 0;
    }
    pause(at?: number) {
      this.record.calls.push(["pause", at]);
      this.record.current = at ?? this.record.current;
    }
    getCurrentTime() {
      return this.record.current;
    }
    setConfig(config: Record<string, unknown>) {
      this.record.calls.push(["speed", config.speed as number]);
    }
    destroy() {
      this.record.destroyed = true;
    }
  }
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const T0 = 1_700_000_000_000;
/** The replay's first event came a second into the recording, so the replayer runs a second behind the audio. */
const EVENTS = [
  { type: 4, timestamp: T0 + 1_000, data: { width: 1000, height: 600 } },
  { type: 2, timestamp: T0 + 1_001, data: {} },
  { type: 3, timestamp: T0 + 20_000, data: {} }
];

const handlers: ThreadHandlers = { reply: vi.fn(async () => null), status: vi.fn(async () => null) };

function last(): [string, number | undefined] | undefined {
  return players.built.at(-1)?.calls.at(-1);
}

beforeEach(() => {
  players.built = [];
  URL.createObjectURL = vi.fn(() => "blob:recording");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event("pause"));
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function player(loaded: { audio: Blob | null; events: typeof EVENTS; t0: number | null }, recording = recordingDetail()) {
  render(
    <RecordingPlayer
      projectId="p1"
      recording={recording}
      threads={[thread("t1", { recordingId: "r1", offsetMs: 12_000 })]}
      people={[ANN]}
      handlers={handlers}
      load={async () => loaded}
    />
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "Play" }).hasAttribute("disabled")).toBe(false));
  if (loaded.events.length > 1) {
    await waitFor(() => expect(players.built).toHaveLength(1));
  }
}

describe("RecordingPlayer", () => {
  it("should replay in a frame with scripts off, starting paused at the beginning", async () => {
    await player({ audio: null, events: EVENTS, t0: T0 });

    expect(players.built[0]?.config).toMatchObject({ UNSAFE_replayCanvas: false, mouseTail: false });
    expect(last()).toEqual(["pause", 0]);
  });

  it("should band the timeline by page and mark each comment, which seeks there and shows the comment", async () => {
    await player({ audio: null, events: EVENTS, t0: T0 });

    expect(screen.getAllByTestId("page-band").map((band) => band.textContent)).toEqual(["/start", "/details"]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Comment by Ann Reviewer at 0:12" })));

    expect(last()).toEqual(["pause", 11_000]);
    expect(screen.getByRole("article")).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Timeline" }).getAttribute("aria-valuetext")).toBe("0:12 of 0:30");
  });

  it("should play and pause from the keyboard and skip five seconds with the arrows, on its own clock without audio", async () => {
    await player({ audio: null, events: EVENTS, t0: T0 });
    const region = screen.getByRole("region", { name: "Recording player" });

    fireEvent.keyDown(region, { key: "ArrowRight" });
    expect(last()).toEqual(["pause", 4_000]);
    fireEvent.keyDown(region, { key: " " });
    expect(last()?.[0]).toBe("play");
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    fireEvent.keyDown(region, { key: " " });
    expect(last()?.[0]).toBe("pause");
    fireEvent.keyDown(region, { key: "ArrowLeft" });
    fireEvent.keyDown(region, { key: "ArrowLeft" });
    expect(last()).toEqual(["pause", 0]);
  });

  it("should leave keys typed into a reply alone", async () => {
    await player({ audio: null, events: EVENTS, t0: T0 });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Comment by Ann Reviewer at 0:12" })));
    const calls = players.built[0]?.calls.length;

    fireEvent.keyDown(screen.getByRole("combobox", { name: /Reply to/ }), { key: " " });

    expect(players.built[0]?.calls.length).toBe(calls);
  });

  it("should change speed for the replay and mark the speed chosen", async () => {
    await player({ audio: null, events: EVENTS, t0: T0 });

    fireEvent.click(screen.getByRole("button", { name: "2×" }));

    expect(last()).toEqual(["speed", 2]);
    expect(screen.getByRole("button", { name: "2×" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("should seek with the skip buttons, Home and End, and a click on the timeline", async () => {
    await player({ audio: null, events: EVENTS, t0: T0 });
    const slider = screen.getByRole("slider", { name: "Timeline" });

    fireEvent.click(screen.getByRole("button", { name: "Forward 5 seconds" }));
    expect(last()).toEqual(["pause", 4_000]);
    fireEvent.click(screen.getByRole("button", { name: "Back 5 seconds" }));
    expect(last()).toEqual(["pause", 0]);
    fireEvent.keyDown(slider, { key: "End" });
    expect(last()).toEqual(["pause", 29_000]);
    fireEvent.keyDown(slider, { key: "Home" });
    expect(last()).toEqual(["pause", 0]);
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 300,
      top: 0,
      height: 10,
      right: 300,
      bottom: 10,
      x: 0,
      y: 0,
      toJSON: () => ({})
    });
    fireEvent.click(slider, { clientX: 150 });
    expect(last()).toEqual(["pause", 14_000]);
  });

  it("should take the audio as its clock, driving the replay from it and putting it back when it drifts", async () => {
    await player({ audio: new Blob(["x"], { type: "audio/webm" }), events: EVENTS, t0: T0 });
    const audio = document.querySelector("audio") as HTMLAudioElement;
    expect(audio.getAttribute("src")).toBe("blob:recording");

    audio.currentTime = 6;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play" })));
    expect(last()).toEqual(["play", 5_000]);

    const record = players.built[0] as (typeof players.built)[number];
    record.current = 1_000;
    fireEvent.timeUpdate(audio);
    expect(last()).toEqual(["play", 5_000]);
    record.current = 5_100;
    const calls = record.calls.length;
    fireEvent.timeUpdate(audio);
    expect(record.calls.length).toBe(calls);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Pause" })));
    expect(last()?.[0]).toBe("pause");
    fireEvent.click(screen.getByRole("button", { name: "1.5×" }));
    expect(audio.playbackRate).toBe(1.5);
    fireEvent.click(screen.getByRole("button", { name: "Forward 5 seconds" }));
    expect(audio.currentTime).toBe(11);
    fireEvent(audio, new Event("seeked"));
    expect(last()).toEqual(["pause", 10_000]);
    fireEvent(audio, new Event("ended"));
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
  });

  it("should take the replay's page size from the replayer and scale it to fit", async () => {
    await player({ audio: null, events: EVENTS, t0: T0 });

    await act(async () => players.built[0]?.resize?.({ width: 1000, height: 600 }));

    expect(document.querySelector<HTMLElement>(".feedback-replay")?.style.width).toBe("1000px");
  });

  it("should play a recording of the reviewer's voice alone", async () => {
    await player({ audio: new Blob(["x"]), events: [], t0: null }, recordingDetail({ segments: recordingDetail().segments.slice(0, 1) }));

    expect(screen.getByText(/voice only/)).toBeTruthy();
    expect(players.built).toHaveLength(0);
  });

  it("should say why a recording could not be loaded", async () => {
    render(
      <RecordingPlayer
        projectId="p1"
        recording={recordingDetail()}
        threads={[]}
        people={[]}
        handlers={handlers}
        load={async () => {
          throw new Error("a part of the recording could not be downloaded");
        }}
      />
    );

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("The recording could not be played: a part of the recording could not be downloaded.")
    );
  });
});

describe("loadRecording", () => {
  const replay0 = gzipSync(JSON.stringify([EVENTS[0], EVENTS[1]]));
  const replay1 = gzipSync(JSON.stringify([EVENTS[2]]));

  it("should join the audio into one file and the replay into one list in time order", async () => {
    const segments = recordingDetail().segments.map((segment) => ({ ...segment, url: `https://blob.example.com/${segment.id}` }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/")) {
          return Response.json({ recording: { segments: [...segments].reverse() } });
        }
        return new Response(url.endsWith("s-a0") ? "audio" : url.endsWith("s-r0") ? replay0 : replay1);
      })
    );

    const loaded = await loadRecording("p1", "r1");

    expect(fetch).toHaveBeenCalledWith("/api/ui/feedback/projects/p1/recordings/r1");
    expect(loaded.audio?.type).toBe("audio/webm");
    expect(loaded.events.map((event) => event.timestamp)).toEqual(EVENTS.map((event) => event.timestamp));
    expect(loaded.t0).toBe(T0 + 1_000);
  });

  it("should fail when the recording or a part of it cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 }))
    );
    await expect(loadRecording("p1", "r1")).rejects.toThrow("the recording could not be read");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).startsWith("/api/")
          ? Response.json({ recording: { segments: [{ ...recordingDetail().segments[0], url: "https://x" }] } })
          : new Response(null, { status: 403 })
      )
    );
    await expect(loadRecording("p1", "r1")).rejects.toThrow("could not be downloaded");
  });
});

describe("RecordingView", () => {
  const data = (status: "ready" | "recording" | "failed") => ({
    project: project(),
    recording: recordingDetail({ status, prototypeVersion: "v3" }),
    threads: [],
    people: []
  });

  it("should say when and through which link the recording was made", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 }))
    );
    render(<RecordingView data={data("ready")} actions={{ reply: vi.fn(), setStatus: vi.fn() }} />);

    expect(screen.getByText(/Round 1 · version v3/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Recording player" })).toBeTruthy();
  });

  it.each([
    ["recording", "still being made"],
    ["failed", "did not finish"]
  ] as const)("should not offer to play a recording that is %s", (status, words) => {
    render(<RecordingView data={data(status)} actions={{ reply: vi.fn(), setStatus: vi.fn() }} />);

    expect(screen.queryByRole("region", { name: "Recording player" })).toBeNull();
    expect(screen.getByText(new RegExp(words))).toBeTruthy();
  });
});
