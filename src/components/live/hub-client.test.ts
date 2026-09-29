import { afterEach, describe, expect, it, vi } from "vitest";
import { connectHub, type HubClientDependencies, type HubEventType, type HubHandlers, retryDelay, streamUrl } from "./hub-client.ts";

class FakeSource {
  readyState = 0;
  closed = false;
  readonly listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data?: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data } as MessageEvent);
    }
  }
}

function harness(ended: boolean[] = []) {
  const sources: FakeSource[] = [];
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
  const probes: number[] = [];
  const dependencies: HubClientDependencies = {
    open: (url) => {
      const source = new FakeSource(url);
      sources.push(source);
      return source;
    },
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as { cleared: boolean }).cleared = true;
    },
    sessionEnded: async () => {
      probes.push(probes.length);
      return ended.shift() ?? false;
    }
  };
  const received: [HubEventType, unknown][] = [];
  const signedOut = vi.fn();
  const handlers: HubHandlers = { event: (type, data) => received.push([type, data]), signedOut };
  return { sources, timers, probes, dependencies, received, handlers, signedOut };
}

async function giveUp(source: FakeSource): Promise<void> {
  source.readyState = 2;
  source.emit("error");
  await Promise.resolve();
}

describe("streamUrl", () => {
  it("should ask for nothing but statuses when nothing is watched", () => {
    expect(streamUrl({ topics: [], match: "any", agent: null })).toBe("/api/ui/stream");
  });

  it("should carry the topics, mode and agent when they are watched", () => {
    expect(streamUrl({ topics: ["a", "b"], match: "all", agent: "agent-1" })).toBe("/api/ui/stream?topics=a%2Cb&mode=all&agent=agent-1");
  });
});

describe("retryDelay", () => {
  it("should double from one second and stop at thirty when retries continue", () => {
    expect([0, 1, 2, 10].map(retryDelay)).toEqual([1_000, 2_000, 4_000, 30_000]);
  });
});

describe("connectHub", () => {
  it("should pass each named event's parsed data to the listener when it arrives", () => {
    const { sources, dependencies, received, handlers } = harness();
    connectHub("/api/ui/stream", handlers, dependencies);

    sources[0]!.emit("post", '{"message":{"id":"1"}}');
    sources[0]!.emit("agent_status", '{"agent_id":"a","status":"busy"}');
    sources[0]!.emit("direct", "not json");

    expect(received).toEqual([
      ["post", { message: { id: "1" } }],
      ["agent_status", { agent_id: "a", status: "busy" }]
    ]);
  });

  it("should check the session and reopen with backoff when the browser gives up on the connection", async () => {
    const { sources, timers, probes, dependencies, handlers, signedOut } = harness();
    connectHub("/api/ui/stream", handlers, dependencies);

    await giveUp(sources[0]!);
    timers[0]!.callback();
    await giveUp(sources[1]!);

    expect(sources[0]!.closed).toBe(true);
    expect(probes).toHaveLength(2);
    expect(timers.map((timer) => timer.ms)).toEqual([1_000, 2_000]);
    expect(sources).toHaveLength(2);
    expect(signedOut).not.toHaveBeenCalled();
  });

  it("should stop retrying and say so once when the browser gives up because the session has ended", async () => {
    const { sources, timers, dependencies, handlers, signedOut } = harness([true]);
    connectHub("/api/ui/stream", handlers, dependencies);

    await giveUp(sources[0]!);
    sources[0]!.emit("error");
    await Promise.resolve();

    expect(signedOut).toHaveBeenCalledTimes(1);
    expect(timers).toEqual([]);
    expect(sources).toHaveLength(1);
  });

  it("should leave reconnecting to the browser, without checking the session, when it is still retrying", () => {
    const { sources, timers, probes, dependencies, handlers } = harness();
    connectHub("/api/ui/stream", handlers, dependencies);

    sources[0]!.readyState = 0;
    sources[0]!.emit("error");

    expect(timers).toEqual([]);
    expect(probes).toEqual([]);
  });

  it("should ask the page to re-read when the connection opens again after an error", () => {
    const { sources, dependencies, received, handlers } = harness();
    connectHub("/api/ui/stream", handlers, dependencies);

    sources[0]!.emit("open");
    sources[0]!.emit("error");
    sources[0]!.emit("open");

    expect(received).toEqual([["resync", {}]]);
  });

  it("should close and cancel a pending retry when it is stopped", async () => {
    const { sources, timers, dependencies, handlers } = harness();
    const stop = connectHub("/api/ui/stream", handlers, dependencies);
    await giveUp(sources[0]!);

    stop();
    timers[0]!.callback();

    expect(timers[0]!.cleared).toBe(true);
    expect(sources).toHaveLength(1);
  });

  it("should neither retry nor report a signed-out session when it is stopped while the session is being checked", async () => {
    const { sources, timers, dependencies, handlers, signedOut } = harness([true]);
    const stop = connectHub("/api/ui/stream", handlers, dependencies);
    sources[0]!.readyState = 2;
    sources[0]!.emit("error");

    stop();
    await Promise.resolve();

    expect(timers).toEqual([]);
    expect(signedOut).not.toHaveBeenCalled();
  });
});

describe("connectHub in the browser", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function browser(sessionStatus = 204) {
    const opened: FakeSource[] = [];
    const fetch = vi.fn(async () => new Response(null, { status: sessionStatus }));
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal(
      "EventSource",
      class extends FakeSource {
        constructor(url: string) {
          super(url);
          opened.push(this);
        }
      }
    );
    return { opened, fetch };
  }

  const quiet: HubHandlers = { event: () => undefined, signedOut: () => undefined };

  it("should open an EventSource and reopen it after the backoff when the browser gives up and the session is good", async () => {
    const { opened, fetch } = browser();
    connectHub("/api/ui/stream", quiet);

    opened[0]!.readyState = 2;
    opened[0]!.emit("error");
    await vi.advanceTimersByTimeAsync(999);
    expect(opened).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(fetch).toHaveBeenCalledWith("/api/ui/session", { cache: "no-store" });
    expect(opened.map((source) => source.url)).toEqual(["/api/ui/stream", "/api/ui/stream"]);
  });

  it("should report the session ended and open nothing more when the session check answers 401", async () => {
    const { opened } = browser(401);
    const signedOut = vi.fn();
    connectHub("/api/ui/stream", { event: () => undefined, signedOut });

    opened[0]!.readyState = 2;
    opened[0]!.emit("error");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(signedOut).toHaveBeenCalledTimes(1);
    expect(opened).toHaveLength(1);
  });

  it("should cancel the pending reopen when it is stopped during the backoff", async () => {
    const { opened } = browser();
    const stop = connectHub("/api/ui/stream", quiet);
    opened[0]!.readyState = 2;
    opened[0]!.emit("error");
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(1);

    stop();

    expect(vi.getTimerCount()).toBe(0);
    expect(opened[0]!.closed).toBe(true);
  });
});
