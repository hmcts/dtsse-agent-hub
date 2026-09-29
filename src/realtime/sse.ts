/** Server-sent events framing, and a stream that pings and cleans up after itself. */

export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Traefik and nginx-style proxies otherwise buffer the response until it completes.
  "x-accel-buffering": "no"
};

export const PING_INTERVAL_MS = 15_000;

/**
 * A stream is closed after at most an hour, so a half-open connection gives its slot back and connections rebalance
 * across pods. The jitter
 * spreads the reconnects of streams that opened together, such as after a deploy.
 */
export const MAX_STREAM_LIFETIME_MS = 60 * 60_000;
export const STREAM_LIFETIME_JITTER_MS = 5 * 60_000;

/** The reconnect delay a client is told to use when the server ends a stream that reached its lifetime. */
export const RECONNECT_AFTER_MS = 1_000;

export function streamLifetimeMs(random: () => number = Math.random): number {
  return MAX_STREAM_LIFETIME_MS - Math.floor(random() * STREAM_LIFETIME_JITTER_MS);
}

export interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

function singleLine(field: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`an SSE ${field} cannot contain a line break`);
  }
  return value;
}

/** One event. Multi-line data is split across `data:` lines, which the client rejoins with `\n`. */
export function sseEvent(frame: SseFrame): string {
  const lines: string[] = [];
  if (frame.id !== undefined) {
    lines.push(`id: ${singleLine("id", frame.id)}`);
  }
  if (frame.event !== undefined) {
    lines.push(`event: ${singleLine("event", frame.event)}`);
  }
  for (const line of frame.data.split(/\r\n|\r|\n/)) {
    lines.push(`data: ${line}`);
  }
  return `${lines.join("\n")}\n\n`;
}

/** A comment line, which clients ignore and proxies see as traffic. */
export function sseComment(text: string): string {
  return `: ${singleLine("comment", text)}\n\n`;
}

/** Sets how long the client waits before reconnecting after this stream ends. */
export function sseRetry(ms: number): string {
  return `retry: ${Math.max(0, Math.floor(ms))}\n\n`;
}

export type Send = (frame: string) => void;

/** Ends the stream, logging why, so the client reconnects rather than holding a stream that has stopped working. */
export type Fail = (error: unknown) => void;

/** Runs when the stream opens. Returns what to run when it closes. */
export type OnOpen = (send: Send, fail: Fail) => (() => void) | Promise<() => void>;

export interface StreamOptions {
  signal: AbortSignal;
  onOpen: OnOpen;
  /** Runs exactly once when the stream closes for any reason, including before or while `onOpen` runs. */
  onClose?: () => void;
  pingIntervalMs?: number;
  maxLifetimeMs?: number;
}

/**
 * A byte stream that sends `: ping` every interval until the client goes away or the stream reaches its lifetime,
 * then runs the cleanup `onOpen` returned exactly once, whether the request was aborted, the reader cancelled or the
 * server ended it. At the lifetime the client is told to reconnect promptly, and the stream closes cleanly.
 */
export function openSseStream({
  signal,
  onOpen,
  onClose,
  pingIntervalMs = PING_INTERVAL_MS,
  maxLifetimeMs = streamLifetimeMs()
}: StreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let closed = false;
  let cleanup: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    if (timer !== undefined) {
      clearInterval(timer);
    }
    if (lifetime !== undefined) {
      clearTimeout(lifetime);
    }
    signal.removeEventListener("abort", close);
    onClose?.();
    cleanup?.();
    try {
      controllerRef?.close();
    } catch {
      // Already closed or errored by the runtime.
    }
  }

  const fail: Fail = (error) => {
    if (!closed) {
      console.warn(`an SSE stream failed: ${error instanceof Error ? error.message : String(error)}`);
      close();
    }
  };

  const send: Send = (frame) => {
    if (closed || controllerRef === undefined) {
      return;
    }
    try {
      controllerRef.enqueue(encoder.encode(frame));
    } catch {
      close();
    }
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controllerRef = controller;
      if (signal.aborted) {
        close();
        return;
      }
      signal.addEventListener("abort", close);
      lifetime = setTimeout(() => {
        send(sseRetry(RECONNECT_AFTER_MS));
        send(sseComment("lifetime reached"));
        close();
      }, maxLifetimeMs);
      // An initial comment so the client and every proxy on the way see the response begin immediately.
      send(sseComment("connected"));
      let opened: () => void;
      try {
        opened = await onOpen(send, fail);
      } catch (error) {
        console.warn(`an SSE stream failed to open: ${error instanceof Error ? error.message : String(error)}`);
        close();
        return;
      }
      if (closed) {
        opened();
        return;
      }
      cleanup = opened;
      timer = setInterval(() => send(sseComment("ping")), pingIntervalMs);
    },
    cancel() {
      close();
    }
  });
}
