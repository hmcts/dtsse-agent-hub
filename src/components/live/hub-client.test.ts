import { afterEach, describe, expect, it, vi } from "vitest";
import { connectHub, type HubClientDependencies, type HubEventType, retryDelay, streamUrl } from "./hub-client.ts";

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

function harness() {
  const sources: FakeSource[] = [];
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
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
    }
  };
  const received: [HubEventType, unknown][] = [];
  return { sources, timers, dependencies, received, listener: (type: HubEventType, data: unknown) => received.push([type, data]) };
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
    const { sources, dependencies, received, listener } = harness();
    connectHub("/api/ui/stream", listener, dependencies);

    sources[0]!.emit("post", '{"message":{"id":"1"}}');
    sources[0]!.emit("agent_status", '{"agent_id":"a","status":"busy"}');
    sources[0]!.emit("direct", "not json");

    expect(received).toEqual([
      ["post", { message: { id: "1" } }],
      ["agent_status", { agent_id: "a", status: "busy" }]
    ]);
  });

  it("should reopen with backoff when the browser gives up on the connection", () => {
    const { sources, timers, dependencies, listener } = harness();
    connectHub("/api/ui/stream", listener, dependencies);

    sources[0]!.readyState = 2;
    sources[0]!.emit("error");
    timers[0]!.callback();
    sources[1]!.readyState = 2;
    sources[1]!.emit("error");

    expect(sources[0]!.closed).toBe(true);
    expect(timers.map((timer) => timer.ms)).toEqual([1_000, 2_000]);
    expect(sources).toHaveLength(2);
  });

  it("should leave reconnecting to the browser when it is still retrying", () => {
    const { sources, timers, dependencies, listener } = harness();
    connectHub("/api/ui/stream", listener, dependencies);

    sources[0]!.readyState = 0;
    sources[0]!.emit("error");

    expect(timers).toEqual([]);
  });

  it("should ask the page to re-read when the connection opens again after an error", () => {
    const { sources, dependencies, received, listener } = harness();
    connectHub("/api/ui/stream", listener, dependencies);

    sources[0]!.emit("open");
    sources[0]!.emit("error");
    sources[0]!.emit("open");

    expect(received).toEqual([["resync", {}]]);
  });

  it("should close and cancel a pending retry when it is stopped", () => {
    const { sources, timers, dependencies, listener } = harness();
    const stop = connectHub("/api/ui/stream", listener, dependencies);
    sources[0]!.readyState = 2;
    sources[0]!.emit("error");

    stop();
    timers[0]!.callback();

    expect(timers[0]!.cleared).toBe(true);
    expect(sources).toHaveLength(1);
  });
});

describe("connectHub in the browser", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function browser() {
    const opened: FakeSource[] = [];
    vi.useFakeTimers();
    vi.stubGlobal(
      "EventSource",
      class extends FakeSource {
        constructor(url: string) {
          super(url);
          opened.push(this);
        }
      }
    );
    return opened;
  }

  it("should open an EventSource and reopen it after the backoff when the browser gives up", () => {
    const opened = browser();
    connectHub("/api/ui/stream", () => undefined);

    opened[0]!.readyState = 2;
    opened[0]!.emit("error");
    vi.advanceTimersByTime(999);
    expect(opened).toHaveLength(1);
    vi.advanceTimersByTime(1);

    expect(opened.map((source) => source.url)).toEqual(["/api/ui/stream", "/api/ui/stream"]);
  });

  it("should cancel the pending reopen when it is stopped during the backoff", () => {
    const opened = browser();
    const stop = connectHub("/api/ui/stream", () => undefined);
    opened[0]!.readyState = 2;
    opened[0]!.emit("error");

    expect(vi.getTimerCount()).toBe(1);

    stop();

    expect(vi.getTimerCount()).toBe(0);
    expect(opened[0]!.closed).toBe(true);
  });
});
