import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Fail,
  MAX_STREAM_LIFETIME_MS,
  openSseStream,
  PING_INTERVAL_MS,
  RECONNECT_AFTER_MS,
  type Send,
  STREAM_LIFETIME_JITTER_MS,
  sseComment,
  sseEvent,
  sseRetry,
  streamLifetimeMs
} from "./sse.ts";

describe("sseEvent", () => {
  it("should frame an id, an event name and data, ending with a blank line", () => {
    expect(sseEvent({ id: "1234", event: "direct", data: '{"message":{}}' })).toBe('id: 1234\nevent: direct\ndata: {"message":{}}\n\n');
  });

  it("should split multi-line data across data lines, whatever the line ending", () => {
    expect(sseEvent({ data: "one\ntwo\r\nthree\rfour" })).toBe("data: one\ndata: two\ndata: three\ndata: four\n\n");
  });

  it("should send data alone when there is no id or event name", () => {
    expect(sseEvent({ data: "x" })).toBe("data: x\n\n");
  });

  it.each([
    ["id", { id: "1\n2", data: "x" }],
    ["event", { event: "direct\r", data: "x" }]
  ])("should refuse a line break in the %s, which would inject a field", (_label, frame) => {
    expect(() => sseEvent(frame)).toThrow(/line break/);
  });
});

describe("sseComment", () => {
  it("should frame a comment line the client ignores", () => {
    expect(sseComment("ping")).toBe(": ping\n\n");
  });
});

describe("sseRetry", () => {
  it("should frame a whole number of milliseconds when given a fraction", () => {
    expect(sseRetry(1500.7)).toBe("retry: 1500\n\n");
  });
});

describe("streamLifetimeMs", () => {
  it.each([
    [0, MAX_STREAM_LIFETIME_MS],
    [0.5, MAX_STREAM_LIFETIME_MS - STREAM_LIFETIME_JITTER_MS / 2],
    [0.999_999, MAX_STREAM_LIFETIME_MS - STREAM_LIFETIME_JITTER_MS + 1]
  ])("should stay within the jitter below the maximum when random gives %s", (random, expected) => {
    expect(streamLifetimeMs(() => random)).toBe(expected);
  });

  it("should use Math.random when no source is given", () => {
    const lifetime = streamLifetimeMs();

    expect(lifetime).toBeLessThanOrEqual(MAX_STREAM_LIFETIME_MS);
    expect(lifetime).toBeGreaterThan(MAX_STREAM_LIFETIME_MS - STREAM_LIFETIME_JITTER_MS);
  });
});

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return text;
    }
    text += decoder.decode(value);
  }
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
}

describe("openSseStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("should open with a comment, send what onOpen sends, ping every interval and clean up on abort", async () => {
    const abort = new AbortController();
    const cleanup = vi.fn();
    const stream = openSseStream({
      signal: abort.signal,
      onOpen: (send) => {
        send(sseEvent({ id: "1", event: "direct", data: "{}" }));
        return cleanup;
      }
    });
    const text = readAll(stream);
    await flush();

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 2);
    abort.abort();

    expect(await text).toBe(": connected\n\nid: 1\nevent: direct\ndata: {}\n\n: ping\n\n: ping\n\n");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("should stop pinging after the client goes away", async () => {
    const abort = new AbortController();
    const stream = openSseStream({ signal: abort.signal, onOpen: () => () => undefined, pingIntervalMs: 1000 });
    const text = readAll(stream);
    await flush();

    abort.abort();
    await vi.advanceTimersByTimeAsync(5000);

    expect(await text).toBe(": connected\n\n");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should clean up once when the reader cancels instead of the request aborting", async () => {
    const abort = new AbortController();
    const cleanup = vi.fn();
    const stream = openSseStream({ signal: abort.signal, onOpen: () => cleanup });
    const reader = stream.getReader();
    await reader.read();
    await flush();

    await reader.cancel();
    abort.abort();

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("should ignore sends after the stream has closed", async () => {
    const abort = new AbortController();
    let send: Send = () => undefined;
    const stream = openSseStream({
      signal: abort.signal,
      onOpen: (given) => {
        send = given;
        return () => undefined;
      }
    });
    const text = readAll(stream);
    await flush();

    abort.abort();
    send(sseEvent({ data: "late" }));

    expect(await text).toBe(": connected\n\n");
  });

  it("should close immediately and never call onOpen when the request was already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    const onOpen = vi.fn();

    expect(await readAll(openSseStream({ signal: abort.signal, onOpen }))).toBe("");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("should run the cleanup straight away when the client left while onOpen was still resolving", async () => {
    const abort = new AbortController();
    const cleanup = vi.fn();
    let resolve: (value: () => void) => void = () => undefined;
    const stream = openSseStream({ signal: abort.signal, onOpen: () => new Promise((done) => (resolve = done)) });
    const text = readAll(stream);
    await flush();

    abort.abort();
    resolve(cleanup);
    await flush();

    expect(await text).toBe(": connected\n\n");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should close the stream, logging why, when onOpen throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const abort = new AbortController();
    const stream = openSseStream({
      signal: abort.signal,
      onOpen: () => {
        throw new Error("no database");
      }
    });

    expect(await readAll(stream)).toBe(": connected\n\n");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("no database"));
  });

  it("should end the stream, log why, and run onClose and the cleanup once, with no ping or lifetime timer left, when onOpen fails it later", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const abort = new AbortController();
    const cleanup = vi.fn();
    const onClose = vi.fn();
    let fail: Fail = () => undefined;
    const stream = openSseStream({
      signal: abort.signal,
      onOpen: (_send, given) => {
        fail = given;
        return cleanup;
      },
      onClose,
      pingIntervalMs: 1000,
      maxLifetimeMs: 3000
    });
    const text = readAll(stream);
    await flush();

    fail(new Error("replay failed"));
    fail(new Error("again"));
    abort.abort();
    await vi.advanceTimersByTimeAsync(5000);

    expect(await text).toBe(": connected\n\n");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("replay failed"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should run onClose and the cleanup once when onOpen fails the stream before returning it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const abort = new AbortController();
    const cleanup = vi.fn();
    const onClose = vi.fn();
    const stream = openSseStream({
      signal: abort.signal,
      onOpen: (_send, fail) => {
        fail("not listening");
        return cleanup;
      },
      onClose
    });

    expect(await readAll(stream)).toBe(": connected\n\n");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("not listening"));
  });

  it("should tell the client to reconnect and close cleanly when the stream reaches its lifetime", async () => {
    const abort = new AbortController();
    const cleanup = vi.fn();
    const onClose = vi.fn();
    const stream = openSseStream({ signal: abort.signal, onOpen: () => cleanup, onClose, pingIntervalMs: 1000, maxLifetimeMs: 2500 });
    const text = readAll(stream);
    await flush();

    await vi.advanceTimersByTimeAsync(2500);

    expect(await text).toBe(`: connected\n\n: ping\n\n: ping\n\nretry: ${RECONNECT_AFTER_MS}\n\n: lifetime reached\n\n`);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should close at the lifetime when onOpen has still not resolved", async () => {
    const abort = new AbortController();
    const cleanup = vi.fn();
    const onClose = vi.fn();
    let resolve: (value: () => void) => void = () => undefined;
    const stream = openSseStream({ signal: abort.signal, onOpen: () => new Promise((done) => (resolve = done)), onClose, maxLifetimeMs: 1000 });
    const text = readAll(stream);
    await flush();

    await vi.advanceTimersByTimeAsync(1000);
    resolve(cleanup);
    await flush();

    expect(await text).toContain(": lifetime reached");
    expect(onClose).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("should default the lifetime to within the jitter below the maximum when none is given", async () => {
    const abort = new AbortController();
    const onClose = vi.fn();
    const stream = openSseStream({ signal: abort.signal, onOpen: () => () => undefined, onClose });
    const text = readAll(stream);
    await flush();

    await vi.advanceTimersByTimeAsync(MAX_STREAM_LIFETIME_MS - STREAM_LIFETIME_JITTER_MS);
    expect(onClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(STREAM_LIFETIME_JITTER_MS);

    expect(await text).toContain(": lifetime reached");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "the request aborts",
      (abort: AbortController, reader: ReadableStreamDefaultReader<Uint8Array>) => {
        abort.abort();
        return reader.cancel();
      }
    ],
    [
      "the reader cancels",
      async (abort: AbortController, reader: ReadableStreamDefaultReader<Uint8Array>) => {
        await reader.cancel();
        abort.abort();
      }
    ]
  ])("should run onClose once when %s", async (_label, end) => {
    const abort = new AbortController();
    const onClose = vi.fn();
    const reader = openSseStream({ signal: abort.signal, onOpen: () => () => undefined, onClose }).getReader();
    await reader.read();
    await flush();

    await end(abort, reader);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("should run onClose when the request was already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    const onClose = vi.fn();

    await readAll(openSseStream({ signal: abort.signal, onOpen: vi.fn(), onClose }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("should run onClose when onOpen throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const abort = new AbortController();
    const onClose = vi.fn();

    await readAll(
      openSseStream({
        signal: abort.signal,
        onOpen: () => {
          throw new Error("no database");
        },
        onClose
      })
    );

    expect(onClose).toHaveBeenCalledOnce();
  });
});
