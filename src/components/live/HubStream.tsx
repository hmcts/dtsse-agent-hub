"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { connectHub, type HubEventType, type HubListener, type StreamWatch, streamUrl } from "./hub-client";

/**
 * One live connection per tab, shared by the sidebar and the page. The page says what it is showing with
 * `useWatch`; the sidebar's agent statuses arrive whatever it watches. A `resync` re-renders the server components,
 * so anything missed while disconnected is read again.
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

  useEffect(() => {
    if (ended) {
      return;
    }
    return connectHub(url, {
      event: (type, data) => {
        if (type === "resync") {
          router.refresh();
        }
        for (const listener of [...listeners.current]) {
          listener(type, data);
        }
      },
      signedOut: endSession
    });
  }, [url, router, ended, endSession]);

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

/** Asks the tab's stream for these topics and this agent while the calling component is mounted. */
export function useWatch(topics: readonly string[], match: StreamWatch["match"], agent: string | null = null): void {
  const context = useContext(HubContext);
  const key = `${topics.join(",")}|${match}|${agent ?? ""}`;
  useEffect(() => {
    if (context === null) {
      return;
    }
    const [joined = "", mode, watchedAgent = ""] = key.split("|");
    context.watch({ topics: joined === "" ? [] : joined.split(","), match: mode === "all" ? "all" : "any", agent: watchedAgent === "" ? null : watchedAgent });
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
