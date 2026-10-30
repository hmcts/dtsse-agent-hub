import type { Match, PostScope } from "@/messages/feed";
import type { HubEvent } from "@/realtime/events";
import { sessionEnded } from "./session.ts";

/**
 * The browser end of `/api/ui/stream`: one `EventSource`, reopened with backoff when it closes for good.
 *
 * `EventSource` retries a dropped connection by itself, but gives up on a non-200 answer and stays closed; that case
 * is retried here. It cannot see the status, so before each retry the session is checked: a 401 means the person has
 * to sign in again, and retrying would never succeed. Whenever the connection opens again after an error, events may
 * have been missed, so a `resync` is delivered for the page to re-read.
 */

/**
 * Every frame name `selectFrame` can send, derived from the hub's own union so a new member of it reaches here.
 * `credential` is not a frame: it arrives as `resync`, because what changed is what the viewer may see rather than
 * anything the page can be handed. `assistant_stop` is not one either, and for a different reason: it is
 * an instruction to a conversation's pod, and the thread redraws from the `assistant_conversation` beside it.
 * `assistant_uploads` is the same: an instruction to the pod, with the page revalidated by the action that caused it.
 * `assistant_lookup` and its answer are as well: the request that asked for one waits on its own response. So are
 * `assistant_welsh` and its answer, which the Welsh page reads back itself.
 * `tagged_post` is not a frame because it says nothing a browser does not already get: it is how one agent's stream
 * picks a post of its own out, and the post arrives here as the `post` beside it, tags included.
 */
export type HubEventType = Exclude<
  HubEvent["type"],
  | "credential"
  | "tagged_post"
  | "assistant_stop"
  | "assistant_uploads"
  | "assistant_lookup"
  | "assistant_lookup_answered"
  | "assistant_welsh"
  | "assistant_welsh_answered"
>;

/**
 * Subscribed one at a time below, because `EventSource` dispatches by `event:` name and has no wildcard. A type
 * missing from this list is silently never delivered to the page, so `Unsubscribed` makes it a compile error.
 */
export const HUB_EVENT_TYPES = [
  "post",
  "agent_status",
  "agent_skills",
  "agent_question",
  "direct",
  "delivery",
  "transcript",
  "virtual_agent",
  "assistant_conversation",
  "resync"
] as const satisfies readonly HubEventType[];

/** Errors as "does not satisfy the constraint 'never'", naming the types `HUB_EVENT_TYPES` leaves out. */
type AssertNever<T extends never> = T;
type _Unsubscribed = AssertNever<Exclude<HubEventType, (typeof HUB_EVENT_TYPES)[number]>>;

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
