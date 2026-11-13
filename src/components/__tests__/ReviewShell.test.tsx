/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLL_MS, ReviewShell } from "@/components/feedback/ReviewShell";
import { AUDIO_SLICE_MS } from "@/components/feedback/recording";
import { MAX_RECORDING_MS } from "@/feedback/limits";
import { type ShellMessage, type WidgetMessageBody, widgetMessage } from "@/feedback/protocol";
import type { FeedbackThreadView } from "@/feedback/thread-store";

const TOKEN = "a".repeat(43);
const VIEWER = "https://agent-hub-viewer.example";
const FRAME_SRC = `${VIEWER}/_auth?ticket=t`;
const BASE = `/api/ui/feedback/review/${TOKEN}`;
const ANCHOR = { selector: "#go", text: "Continue", tag: "button", rect: { x: 1, y: 2, width: 3, height: 4 }, viewport: { width: 800, height: 600 } };
const SNAPSHOT = [
  { type: 4, timestamp: 1000, data: {} },
  { type: 2, timestamp: 1000, data: {} }
];

function thread(id: string, status: FeedbackThreadView["status"] = "open", body = "Hard to find"): FeedbackThreadView {
  return {
    id,
    projectId: "p",
    linkId: "l",
    pagePath: "/start",
    anchor: ANCHOR,
    status,
    author: { oid: "o1", name: "Ann Reviewer" },
    resolvedBy: null,
    resolvedAt: null,
    snapshotBlob: null,
    recordingId: null,
    offsetMs: null,
    prototypeVersion: null,
    createdAt: "2026-11-13T10:00:00.000Z",
    updatedAt: "2026-11-13T10:00:00.000Z",
    comments: [{ id: `${id}-c`, author: { oid: "o1", name: "Ann Reviewer" }, body, createdAt: "2026-11-13T10:00:00.000Z", mentions: [] }]
  };
}

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

let calls: Call[];
let threads: FeedbackThreadView[];
let blobStatus: number;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function answer(url: string, method: string, body: unknown): Response {
  if (url.startsWith("https://blob.example/")) {
    return new Response(null, { status: blobStatus });
  }
  const path = url.replace(BASE, "");
  if (path.startsWith("/threads?") && method === "GET") {
    return json({ threads });
  }
  if (path === "/threads" && method === "POST") {
    const created = thread("new", "open", (body as { body: string }).body);
    threads = [...threads, created];
    return json({ thread: created, snapshot_url: "https://blob.example/snapshot?sas" }, 201);
  }
  if (path === "/people") {
    return json({ people: [{ oid: "o2", name: "Bob Builder" }] });
  }
  if (path === "/recordings") {
    return json({ recording: { id: "rec-1", startedAt: "2026-11-13T10:00:00.000Z" } }, 201);
  }
  if (path.endsWith("/uploads")) {
    const { kind, seq } = body as { kind: string; seq: number };
    return json({ url: `https://blob.example/${kind}/${seq}?sas`, segment_id: `${kind}-${seq}` }, 201);
  }
  if (path.endsWith("/complete")) {
    return json({ recording: { id: "rec-1" } });
  }
  return json({ error: "not found" }, 404);
}

class FakeMediaRecorder {
  static last: FakeMediaRecorder | undefined;
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstart: (() => void) | null = null;
  onstop: (() => void) | null = null;
  started: number | undefined;
  static isTypeSupported = () => true;

  constructor() {
    FakeMediaRecorder.last = this;
  }

  start(timeslice: number) {
    this.started = timeslice;
    queueMicrotask(() => this.onstart?.());
  }

  stop() {
    this.ondataavailable?.({ data: new Blob(["last"]) });
    queueMicrotask(() => this.onstop?.());
  }
}

let getUserMedia: ReturnType<typeof vi.fn>;
let posted: ShellMessage[];

function frame(): HTMLIFrameElement {
  return document.querySelector("iframe") as HTMLIFrameElement;
}

async function fromWidget(body: WidgetMessageBody, init: { origin?: string; source?: MessageEventSource | null } = {}): Promise<void> {
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: widgetMessage(body),
        origin: init.origin ?? VIEWER,
        source: init.source === undefined ? (frame().contentWindow as Window) : init.source
      })
    );
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const realSetTimeout = globalThis.setTimeout;

/**
 * Waits on the real clock, leaving the fake one where it is, until `done`. Snapshots and replay segments are gzipped
 * through `CompressionStream`, which runs on the real clock: advancing the fake one does not wait for it.
 */
async function untilReal(done: () => boolean): Promise<void> {
  for (let waited = 0; !done(); waited += 5) {
    if (waited >= 5000) {
      throw new Error("timed out waiting on the real clock");
    }
    await act(async () => {
      await new Promise((resolve) => realSetTimeout(resolve, 5));
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

function snapshotPuts(): Call[] {
  return calls.filter((call) => call.url === "https://blob.example/snapshot?sas");
}

function shell() {
  render(
    <ReviewShell
      token={TOKEN}
      frameSrc={FRAME_SRC}
      projectName="Claims prototype"
      linkLabel="Version 1"
      viewerName="Ann Reviewer"
      access="reviewer"
      maskInputs={true}
      retentionDays={30}
    />
  );
  posted = [];
  vi.spyOn(frame().contentWindow as Window, "postMessage").mockImplementation(((message: ShellMessage) => void posted.push(message)) as never);
}

function threadReads(): Call[] {
  return calls.filter((call) => call.method === "GET" && call.url.includes("/threads?"));
}

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  threads = [thread("t1")];
  blobStatus = 201;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
      calls.push({ url, method, body, headers: (init.headers ?? {}) as Record<string, string> });
      return answer(url, method, body);
    })
  );
  getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ReviewShell", () => {
  it("should frame the prototype sandboxed and without top navigation", () => {
    shell();
    expect(frame().getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
    );
    expect(frame().getAttribute("title")).toBe("Version 1");
    expect(frame().getAttribute("src")).toBe(FRAME_SRC);
    expect(frame().hasAttribute("allow")).toBe(false);
    expect(screen.getByText("Reviewer")).toBeTruthy();
  });

  it("should keep the frame where it is when the page renders again with a fresh ticket", () => {
    const props = {
      token: TOKEN,
      projectName: "Claims prototype",
      linkLabel: "Version 1",
      viewerName: "Ann Reviewer",
      access: "reviewer" as const,
      maskInputs: true,
      retentionDays: 30
    };
    const { rerender } = render(<ReviewShell {...props} frameSrc={FRAME_SRC} />);
    rerender(<ReviewShell {...props} frameSrc={`${VIEWER}/_auth?ticket=fresh`} />);
    expect(frame().getAttribute("src")).toBe(FRAME_SRC);
  });

  it("should show the page's threads and send their markers once the widget says hello", async () => {
    shell();
    await fromWidget({ type: "hello", path: "/start", title: "Start", version: "" });
    expect(threadReads()[0]?.url).toBe(`${BASE}/threads?page_path=%2Fstart`);
    expect(screen.getByRole("heading", { name: "Comment 1: Ann Reviewer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "1 open comment" })).toBeTruthy();
    expect(posted.at(-1)).toMatchObject({ type: "markers", threads: [{ id: "t1", number: 1, status: "open" }] });
  });

  it("should ignore a message from the wrong origin or another window", async () => {
    shell();
    await fromWidget({ type: "hello", path: "/start", title: "", version: "" }, { origin: "https://proto.example" });
    await fromWidget({ type: "hello", path: "/start", title: "", version: "" }, { source: window });
    await fromWidget({ type: "hello", path: "/start", title: "", version: "" }, { source: null });
    expect(threadReads()).toHaveLength(0);
    expect((screen.getByRole("button", { name: "Add comment" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("should pick an element and create a thread with its snapshot", async () => {
    shell();
    await fromWidget({ type: "hello", path: "/start", title: "", version: "" });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    expect(posted.at(-1)).toMatchObject({ type: "pick-start" });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    await fromWidget({ type: "picked", path: "/start", anchor: ANCHOR, snapshot: SNAPSHOT });
    expect(screen.getByText(/button “Continue”/)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Your comment" }), { target: { value: "Where does this go?" } });
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    await untilReal(() => snapshotPuts().length > 0);
    await settle();
    const created = calls.find((call) => call.method === "POST" && call.url === `${BASE}/threads`);
    expect(created?.body).toEqual({ page_path: "/start", anchor: ANCHOR, body: "Where does this go?", snapshot: true });
    const put = snapshotPuts()[0];
    expect(put?.method).toBe("PUT");
    expect(put?.headers["x-ms-blob-type"]).toBe("BlockBlob");
    expect(screen.getByRole("status", { name: "" }).textContent).toContain("Comment saved");
    expect(screen.getByRole("heading", { name: "Comment 2: Ann Reviewer" })).toBeTruthy();
  });

  it("should cancel picking from the bar and when the widget cancels", async () => {
    shell();
    await fromWidget({ type: "hello", path: "/start", title: "", version: "" });
    fireEvent.keyDown(window, { altKey: true, code: "KeyC" });
    expect(posted.at(-1)).toMatchObject({ type: "pick-start" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(posted.at(-1)).toMatchObject({ type: "pick-cancel" });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    await fromWidget({ type: "pick-cancel" });
    expect(screen.getByRole("button", { name: "Add comment" })).toBeTruthy();
  });

  it("should ask for consent before using the microphone", async () => {
    shell();
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    const dialog = screen.getByRole("dialog", { name: "Record your review?" });
    expect(dialog.textContent).toContain("Only this project's team can listen to it.");
    expect(dialog.textContent).toContain("kept for 30 days");
    expect(getUserMedia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("should record, upload each chunk and complete the recording", async () => {
    vi.setSystemTime(new Date("2026-11-13T10:00:00.000Z"));
    shell();
    await fromWidget({ type: "hello", path: "/start", title: "", version: "" });
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await settle();
    await settle();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(FakeMediaRecorder.last?.started).toBe(AUDIO_SLICE_MS);
    expect(posted.at(-1)).toMatchObject({ type: "record-start", maskInputs: true });
    const t0 = Date.now();

    await fromWidget({ type: "replay-events", path: "/start", events: [{ type: 3, timestamp: t0 + 500, data: {} }] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUDIO_SLICE_MS);
      FakeMediaRecorder.last?.ondataavailable?.({ data: new Blob(["audio-0"]) });
    });
    await settle();

    await fromWidget({ type: "hello", path: "/next", title: "", version: "" });
    expect(posted.filter((message) => message.type === "record-start")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /Stop recording/ }));
    await settle(500);
    await untilReal(() => calls.some((call) => call.url.endsWith("/complete")));
    await settle();
    expect(posted.some((message) => message.type === "record-stop")).toBe(true);

    const uploads = calls.filter((call) => call.url.endsWith("/uploads")).map((call) => call.body);
    expect(uploads).toEqual([
      expect.objectContaining({ kind: "replay", seq: 0, offset_ms: 500, page_path: "/start" }),
      { kind: "audio", seq: 0, offset_ms: 0, bytes: 7 },
      { kind: "audio", seq: 1, offset_ms: AUDIO_SLICE_MS, bytes: 4 }
    ]);
    expect(calls.filter((call) => call.method === "PUT").map((call) => call.url)).toEqual([
      "https://blob.example/replay/0?sas",
      "https://blob.example/audio/0?sas",
      "https://blob.example/audio/1?sas"
    ]);
    expect(calls.find((call) => call.url.endsWith("/complete"))?.body).toMatchObject({ duration_ms: expect.any(Number) });
    expect(screen.getByRole("button", { name: "Record" })).toBeTruthy();
  });

  it("should stop once at the time limit when finishing the recording takes longer than a tick", async () => {
    vi.setSystemTime(new Date("2026-11-13T10:00:00.000Z"));
    const completes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET";
        if (url.endsWith("/complete")) {
          completes.push(url);
          return await new Promise<Response>(() => undefined);
        }
        return answer(url, method, typeof init.body === "string" ? JSON.parse(init.body) : init.body);
      })
    );
    shell();
    await fromWidget({ type: "hello", path: "/start", title: "", version: "" });
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await settle();
    await settle();

    vi.setSystemTime(Date.now() + MAX_RECORDING_MS);
    await settle(1000);
    await settle(10_000);

    expect(posted.filter((message) => message.type === "record-stop")).toHaveLength(1);
    expect(completes).toHaveLength(1);
  });

  it("should carry on and say so when a chunk cannot be uploaded", async () => {
    blobStatus = 500;
    shell();
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await settle();
    await settle();
    await act(async () => {
      FakeMediaRecorder.last?.ondataavailable?.({ data: new Blob(["audio-0"]) });
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(calls.filter((call) => call.url === "https://blob.example/audio/0?sas")).toHaveLength(4);
    expect(screen.getByRole("alert").textContent).toContain("could not be saved");
  });

  it("should say so when the microphone is refused", async () => {
    getUserMedia.mockRejectedValueOnce(new Error("denied"));
    shell();
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("microphone could not be used");
    expect(calls.some((call) => call.url.endsWith("/recordings"))).toBe(false);
  });

  it("should poll the page's threads only while the page is visible", async () => {
    shell();
    await fromWidget({ type: "hello", path: "/start", title: "", version: "" });
    expect(threadReads()).toHaveLength(1);
    await settle(POLL_MS);
    expect(threadReads()).toHaveLength(2);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    await settle(POLL_MS * 2);
    expect(threadReads()).toHaveLength(2);
  });

  it("should read the new page's threads when the frame navigates", async () => {
    shell();
    await fromWidget({ type: "hello", path: "/start", title: "", version: "" });
    await fromWidget({ type: "navigated", path: "/next" });
    expect(threadReads().at(-1)?.url).toBe(`${BASE}/threads?page_path=%2Fnext`);
  });

  it("should say feedback is unavailable when no widget says hello after the frame loads", async () => {
    shell();
    fireEvent.load(frame());
    await settle(5000);
    expect(screen.getByText(/Feedback is unavailable on this page/)).toBeTruthy();
  });

  it("should focus a thread's card from its marker, and its marker from the card", async () => {
    threads = [thread("t1"), thread("t2")];
    shell();
    await fromWidget({ type: "hello", path: "/start", title: "", version: "" });
    await fromWidget({ type: "marker-clicked", id: "t2" });
    expect(screen.getByRole("article", { name: "Comment 2: Ann Reviewer" }).className).toContain("ring-2");
    fireEvent.click(screen.getByRole("button", { name: "Comment 1: Ann Reviewer" }));
    expect(posted.at(-1)).toEqual(expect.objectContaining({ type: "focus-thread", id: "t1" }));
  });

  it("should hide resolved threads unless asked, and resolve and reply through the routes", async () => {
    threads = [thread("t1"), thread("t2", "resolved")];
    shell();
    await fromWidget({ type: "hello", path: "/start", title: "", version: "" });
    expect(screen.queryByRole("heading", { name: "Comment 2: Ann Reviewer" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show resolved" }));
    expect(screen.getByRole("heading", { name: "Comment 2: Ann Reviewer" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Resolve" })[0] as HTMLElement);
    await settle();
    expect(calls.find((call) => call.method === "PATCH")).toMatchObject({ url: `${BASE}/threads/t1`, body: { status: "resolved" } });
    fireEvent.change(screen.getAllByRole("combobox", { name: "Reply to Ann Reviewer" })[0] as HTMLElement, { target: { value: "Agreed" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Reply" })[0] as HTMLElement);
    await settle();
    expect(calls.find((call) => call.url.endsWith("/comments"))?.body).toEqual({ body: "Agreed" });
  });

  it("should mark a thread whose element the widget cannot find", async () => {
    shell();
    await fromWidget({ type: "hello", path: "/start", title: "", version: "" });
    await fromWidget({ type: "detached", ids: ["t1"] });
    expect(screen.getByText(/not on the page as it is now/)).toBeTruthy();
  });

  it("should collapse the bar to a handle and back", () => {
    shell();
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("button", { name: "Add comment" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show feedback bar" }));
    expect(screen.getByRole("button", { name: "Add comment" })).toBeTruthy();
  });
});

describe("ReviewShell's refusals and dialogs", () => {
  it("should keep focus in the consent dialog and close it on Escape", () => {
    shell();
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    const notNow = screen.getByRole("button", { name: "Not now" });
    const start = screen.getByRole("button", { name: "Start recording" });
    expect(document.activeElement).toBe(notNow);
    fireEvent.keyDown(notNow, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(start);
    fireEvent.keyDown(start, { key: "Tab" });
    expect(document.activeElement).toBe(notNow);
    fireEvent.keyDown(notNow, { key: "a" });
    fireEvent.keyDown(notNow, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Record" }));
  });

  it("should ask for consent once, and go straight to the microphone the next time", async () => {
    shell();
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await settle();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Stop recording/ }));
    await settle(500);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("should say why a recording could not start, and let go of the microphone", async () => {
    const stop = vi.fn();
    getUserMedia.mockResolvedValueOnce({ getTracks: () => [{ stop }] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url.endsWith("/recordings") ? json({ error: "that is a lot at once" }, 429) : answer(url, "GET", undefined)))
    );
    shell();
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await settle();
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("The recording could not start: That is a lot at once");
    expect(stop).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should say why a comment could not be saved, and keep it to try again", async () => {
    shell();
    await fromWidget({ type: "hello", path: "/start", title: "", version: "" });
    await fromWidget({ type: "picked", path: "/start", anchor: { ...ANCHOR, text: "x".repeat(80) }, snapshot: [] });
    expect(screen.getByText(/button “x+…”/)).toBeTruthy();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "body: too long" }, 400))
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Your comment" }), { target: { value: "Hmm" } });
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("Body: too long");
    expect(screen.getByRole("form", { name: "New comment" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("form", { name: "New comment" })).toBeNull();
  });

  it("should save a comment without a snapshot when the page sent none, and say so when the snapshot upload fails", async () => {
    blobStatus = 403;
    shell();
    await fromWidget({ type: "hello", path: "/start", title: "", version: "" });
    await fromWidget({ type: "picked", path: "/start", anchor: ANCHOR, snapshot: SNAPSHOT });
    fireEvent.change(screen.getByRole("combobox", { name: "Your comment" }), { target: { value: "Hmm" } });
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    await untilReal(() => snapshotPuts().length > 0);
    await settle(20_000);
    await settle();
    expect(snapshotPuts()).toHaveLength(4);
    expect(screen.getByRole("alert").textContent).toContain("picture of the page could not be");
  });

  it("should send a comment made during a recording with its place in it", async () => {
    shell();
    await fromWidget({ type: "hello", path: "/start", title: "", version: "" });
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await settle();
    await settle();
    await settle(3000);
    expect(screen.getByRole("button", { name: /Stop recording 00:03/ })).toBeTruthy();
    await fromWidget({ type: "picked", path: "/start", anchor: ANCHOR, snapshot: [] });
    fireEvent.change(screen.getByRole("combobox", { name: "Your comment" }), { target: { value: "Here" } });
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    await settle();
    const created = calls.find((call) => call.method === "POST" && call.url === `${BASE}/threads`);
    expect(created?.body).toMatchObject({ recording_id: "rec-1", offset_ms: expect.any(Number), snapshot: false });
  });

  it("should say when the page's threads cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url.includes("/threads?") ? json({ error: "that feedback link is not there" }, 404) : answer(url, "GET", undefined)))
    );
    shell();
    await fromWidget({ type: "hello", path: "/start", title: "", version: "" });
    expect(screen.getByRole("alert").textContent).toContain("That feedback link is not there");
  });

  it("should not start picking before the widget has said hello", () => {
    shell();
    fireEvent.keyDown(window, { altKey: true, code: "KeyC" });
    expect(posted).toHaveLength(0);
  });
});
