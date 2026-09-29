import type { Match, PostScope } from "@/messages/feed";

/**
 * The browser end of `/api/ui/stream`: one `EventSource`, reopened with backoff when it closes for good.
 *
 * `EventSource` retries a dropped connection by itself, but gives up on a non-200 answer (a pod restarting, a
 * redirect to sign in) and stays closed; that case is retried here. Whenever the connection opens again after an
 * error, events may have been missed, so a `resync` is delivered for the page to re-read.
 */

export type HubEventType = "post" | "agent_status" | "direct" | "delivery" | "resync";

export const HUB_EVENT_TYPES: readonly HubEventType[] = ["post", "agent_status", "direct", "delivery", "resync"];

export type HubListener = (type: HubEventType, data: unknown) => void;

export interface StreamWatch {
  topics: PostScope;
  match: Match;
  agent: string | null;
}

export function streamUrl(watch: StreamWatch): string {
  const query = new URLSearchParams();
  if (watch.topics === "everything") {
    query.set("everything", "1");
  } else if (watch.topics.length > 0) {
    query.set("topics", watch.topics.join(","));
    query.set("mode", watch.match);
  }
  if (watch.agent !== null) {
    query.set("agent", watch.agent);
  }
  const search = query.toString();
  return search === "" ? "/api/ui/stream" : `/api/ui/stream?${search}`;
}

interface EventSourceLike {
  readyState: number;
  addEventListener: (type: string, listener: (event: MessageEvent) => void) => void;
  close: () => void;
}

export interface HubClientDependencies {
  open: (url: string) => EventSourceLike;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
}

const CLOSED = 2;
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

export function retryDelay(attempt: number): number {
  return Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** attempt);
}

function browserDependencies(): HubClientDependencies {
  return {
    open: (url) => new EventSource(url),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
  };
}

/** Connects and keeps connected until the returned function is called. */
export function connectHub(url: string, listener: HubListener, dependencies: HubClientDependencies = browserDependencies()): () => void {
  let stopped = false;
  let source: EventSourceLike | undefined;
  let timer: unknown;
  let attempt = 0;
  let missed = false;

  function connect(): void {
    if (stopped) {
      return;
    }
    const current = dependencies.open(url);
    source = current;
    current.addEventListener("open", () => {
      attempt = 0;
      if (missed) {
        missed = false;
        listener("resync", {});
      }
    });
    current.addEventListener("error", () => {
      missed = true;
      if (current.readyState === CLOSED && source === current && !stopped) {
        current.close();
        timer = dependencies.setTimer(connect, retryDelay(attempt));
        attempt += 1;
      }
    });
    for (const type of HUB_EVENT_TYPES) {
      current.addEventListener(type, (event) => {
        let data: unknown;
        try {
          data = JSON.parse(event.data as string);
        } catch {
          return;
        }
        listener(type, data);
      });
    }
  }

  connect();

  return () => {
    stopped = true;
    if (timer !== undefined) {
      dependencies.clearTimer(timer);
    }
    source?.close();
  };
}
