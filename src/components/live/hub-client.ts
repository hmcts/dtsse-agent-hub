import type { Match, PostScope } from "@/messages/feed";
import { sessionEnded } from "./session.ts";

/**
 * The browser end of `/api/ui/stream`: one `EventSource`, reopened with backoff when it closes for good.
 *
 * `EventSource` retries a dropped connection by itself, but gives up on a non-200 answer and stays closed; that case
 * is retried here. It cannot see the status, so before each retry the session is checked: a 401 means the person has
 * to sign in again, and retrying would never succeed. Whenever the connection opens again after an error, events may
 * have been missed, so a `resync` is delivered for the page to re-read.
 */

export type HubEventType = "post" | "agent_status" | "direct" | "delivery" | "transcript" | "virtual_agent" | "resync";

export const HUB_EVENT_TYPES: readonly HubEventType[] = ["post", "agent_status", "direct", "delivery", "transcript", "virtual_agent", "resync"];

export type HubListener = (type: HubEventType, data: unknown) => void;

export interface HubHandlers {
  event: HubListener;
  /** Called once, with the connection closed for good, when the stream failed because the session has ended. */
  signedOut: () => void;
}

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
  sessionEnded: () => Promise<boolean>;
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
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    sessionEnded: () => sessionEnded()
  };
}

/** Connects and keeps connected until the returned function is called. */
export function connectHub(url: string, handlers: HubHandlers, dependencies: HubClientDependencies = browserDependencies()): () => void {
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
        handlers.event("resync", {});
      }
    });
    current.addEventListener("error", () => {
      missed = true;
      if (current.readyState === CLOSED && source === current && !stopped) {
        current.close();
        void dependencies.sessionEnded().then((ended) => {
          if (stopped || source !== current) {
            return;
          }
          if (ended) {
            stopped = true;
            handlers.signedOut();
            return;
          }
          timer = dependencies.setTimer(connect, retryDelay(attempt));
          attempt += 1;
        });
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
        handlers.event(type, data);
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
