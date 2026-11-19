"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { whenOnline } from "./connectivity";
import { connectHub, type HubEventType, type HubListener, type StreamWatch, streamUrl } from "./hub-client";

/**
 * One live connection per tab, shared by the sidebar and the page. The page says what it is showing with
 * `useWatch`; the sidebar's agent statuses arrive whatever it watches. A `resync` re-renders the server components,
 * so anything missed while disconnected is read again.
 *
 * A `resync` usually follows a dropped connection, so the network may still be down when it arrives. Refreshing
 * then fails the RSC request and takes the page to the error boundary, so the refresh waits for the network. One
 * waiting refresh covers every `resync` that arrived while the network was down: they all re-read the same page.
 *
 * Once the session has ended, found by the stream or by any request the page makes, the stream stays closed and
 * `useSessionEnded` says so.
 */

interface HubContextValue {
  subscribe: (listener: HubListener) => () => void;
  watch: (watch: StreamWatch | null) => void;
  ended: boolean;
  endSession: () => void;
}

const NOTHING: StreamWatch = { topics: [], match: "any", agent: null };

const HubContext = createContext<HubContextValue | null>(null);

export function HubStreamProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const listeners = useRef(new Set<HubListener>());
  const [watched, setWatched] = useState<StreamWatch>(NOTHING);
  const [ended, setEnded] = useState(false);
  const url = streamUrl(watched);
  const endSession = useCallback(() => setEnded(true), []);
  const waitingRefresh = useRef<(() => void) | null>(null);

  // Only on unmount: a refresh waiting for the network outlives a change to what the page watches.
  useEffect(
    () => () => {
      waitingRefresh.current?.();
      waitingRefresh.current = null;
    },
    []
  );

  // The stream the tab had before this one, so a new one opened in its place catches up on what fell between them: the
  // page was read before the new stream opened, and anything announced in between — a reply landing as the person
  // moved to its chat — would otherwise not be heard until something else changed.
  const previousUrl = useRef<string | null>(null);
  const onChat = watched.agent !== null;

  useEffect(() => {
    if (ended) {
      return;
    }
    // Only onto a chat's stream, where an event lost in between is a reply that never shows; elsewhere the page read on
    // arriving is current enough, and a resync would read it all again for nothing.
    const catchUp = previousUrl.current !== null && previousUrl.current !== url && onChat;
    previousUrl.current = url;
    return connectHub(
      url,
      {
        event: (type, data) => {
          if (type === "resync" && waitingRefresh.current === null) {
            waitingRefresh.current = whenOnline(() => {
              waitingRefresh.current = null;
              router.refresh();
            });
          }
          for (const listener of [...listeners.current]) {
            listener(type, data);
          }
        },
        signedOut: endSession
      },
      undefined,
      catchUp
    );
  }, [url, onChat, router, ended, endSession]);

  const value = useMemo<HubContextValue>(
    () => ({
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => {
          listeners.current.delete(listener);
        };
      },
      watch: (next) => setWatched(next ?? NOTHING),
      ended,
      endSession
    }),
    [ended, endSession]
  );

  return <HubContext.Provider value={value}>{children}</HubContext.Provider>;
}

/** Asks the tab's stream for these topics, or every post, and this agent while the calling component is mounted. */
export function useWatch(topics: StreamWatch["topics"], match: StreamWatch["match"], agent: string | null = null): void {
  const context = useContext(HubContext);
  const key = JSON.stringify({ topics, match, agent });
  useEffect(() => {
    if (context === null) {
      return;
    }
    context.watch(JSON.parse(key) as StreamWatch);
    return () => context.watch(null);
  }, [context, key]);
}

/** Calls `handler` for every event of `type`. The latest handler is used, so it may close over fresh state. */
export function useHubEvent<T>(type: HubEventType, handler: (data: T) => void): void {
  const context = useContext(HubContext);
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (context === null) {
      return;
    }
    return context.subscribe((eventType, data) => {
      if (eventType === type) {
        latest.current(data as T);
      }
    });
  }, [context, type]);
}

/**
 * A stable way to hear every event of `type` from code that is not a component's render, such as a wait that
 * `podJobClient`'s `waitForPodJob` runs: the returned function subscribes a listener and answers its unsubscribe.
 * Outside a provider it hears nothing, so a caller falls back on whatever else it does, such as polling.
 */
export function useHubSubscribe(type: HubEventType): (listener: (data: unknown) => void) => () => void {
  const context = useContext(HubContext);
  return useCallback(
    (listener: (data: unknown) => void) =>
      context === null
        ? ignore
        : context.subscribe((eventType, data) => {
            if (eventType === type) {
              listener(data);
            }
          }),
    [context, type]
  );
}

/** Whether the tab has found that the person has to sign in again. */
export function useSessionEnded(): boolean {
  return useContext(HubContext)?.ended ?? false;
}

/**
 * What a component that was answered 401 calls, so the stream stops and the banner shows. The component shows its
 * own message beside what failed as well.
 */
export function useEndSession(): () => void {
  return useContext(HubContext)?.endSession ?? ignore;
}

function ignore(): void {}
