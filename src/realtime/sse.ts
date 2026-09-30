/** Server-sent events framing, and a stream that pings and cleans up after itself. */

export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Traefik and nginx-style proxies otherwise buffer the response until it completes.
  "x-accel-buffering": "no"
};

export const PING_INTERVAL_MS = 15_000;

/** Every stream ends within this, because the shared AAT Traefik stops forwarding any response after 30 seconds. */
export const DEFAULT_STREAM_MAX_SECONDS = 25;
export const MIN_STREAM_MAX_SECONDS = 5;

/** The share of the lifetime a stream may end early by, so streams that opened together do not reconnect together. */
export const STREAM_LIFETIME_JITTER = 0.1;

/** The reconnect delay a browser is told, at the start of every stream, to use once it ends. */
export const RECONNECT_AFTER_MS = 1_000;

/**
 * `STREAM_MAX_SECONDS`: a positive integer, raised to at least `MIN_STREAM_MAX_SECONDS`. Unset gives the default; any
 * other value is logged and gives the default too, so a bad setting cannot stop streams working.
 */
export function streamMaxSeconds(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env.STREAM_MAX_SECONDS?.trim();
  if (raw === undefined || raw === "") {
    return DEFAULT_STREAM_MAX_SECONDS;
  }
  if (!/^\d+$/.test(raw) || Number(raw) === 0) {
    console.warn(`STREAM_MAX_SECONDS must be a positive integer, not ${JSON.stringify(raw.slice(0, 32))}; using ${DEFAULT_STREAM_MAX_SECONDS}`);
    return DEFAULT_STREAM_MAX_SECONDS;
  }
  return Math.max(MIN_STREAM_MAX_SECONDS, Number(raw));
}

export function streamLifetimeMs(maxSeconds: number = streamMaxSeconds(), random: () => number = Math.random): number {
  const maxMs = maxSeconds * 1000;
  return maxMs - Math.floor(random() * maxMs * STREAM_LIFETIME_JITTER);
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
  /** Sent just before the stream ends at its lifetime, so the client can tell a planned close from a failure. */
  closingFrame?: string;
}

export const LIFETIME_REACHED = sseComment("lifetime reached");

/**
 * A byte stream that opens by telling the client to reconnect `RECONNECT_AFTER_MS` after it ends, then sends `: ping`
 * every interval until the client goes away or the stream reaches its lifetime. It runs the cleanup `onOpen` returned
 * exactly once, whether the request was aborted, the reader cancelled or the server ended it. At the lifetime it sends
 * `closingFrame` and closes cleanly.
 */
export function openSseStream({
  signal,
  onOpen,
  onClose,
  pingIntervalMs = PING_INTERVAL_MS,
  maxLifetimeMs = streamLifetimeMs(),
  closingFrame = LIFETIME_REACHED
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
        send(closingFrame);
        close();
      }, maxLifetimeMs);
      // An initial comment so the client and every proxy on the way see the response begin immediately.
      send(sseComment("connected"));
      send(sseRetry(RECONNECT_AFTER_MS));
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
