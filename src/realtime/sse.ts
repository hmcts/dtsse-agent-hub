/** Server-sent events framing, and a stream that pings and cleans up after itself. */

export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Traefik and nginx-style proxies otherwise buffer the response until it completes.
  "x-accel-buffering": "no"
};

export const PING_INTERVAL_MS = 15_000;

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

export type Send = (frame: string) => void;

/** Runs when the stream opens. Returns what to run when it closes. */
export type OnOpen = (send: Send) => (() => void) | Promise<() => void>;

export interface StreamOptions {
  signal: AbortSignal;
  onOpen: OnOpen;
  pingIntervalMs?: number;
}

/**
 * A byte stream that sends `: ping` every interval until the client goes away, then runs the cleanup `onOpen`
 * returned exactly once, whether the request was aborted or the reader cancelled.
 */
export function openSseStream({ signal, onOpen, pingIntervalMs = PING_INTERVAL_MS }: StreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let closed = false;
  let cleanup: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    if (timer !== undefined) {
      clearInterval(timer);
    }
    signal.removeEventListener("abort", close);
    cleanup?.();
    try {
      controllerRef?.close();
    } catch {
      // Already closed or errored by the runtime.
    }
  }

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
      // An initial comment so the client and every proxy on the way see the response begin immediately.
      send(sseComment("connected"));
      let opened: () => void;
      try {
        opened = await onOpen(send);
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
