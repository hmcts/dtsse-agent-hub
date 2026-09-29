"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { connectHub, type HubEventType, type HubListener, type StreamWatch, streamUrl } from "./hub-client";

/**
 * One live connection per tab, shared by the sidebar and the page. The page says what it is showing with
 * `useWatch`; the sidebar's agent statuses arrive whatever it watches. A `resync` re-renders the server components,
 * so anything missed while disconnected is read again.
 */

interface HubContextValue {
  subscribe: (listener: HubListener) => () => void;
  watch: (watch: StreamWatch | null) => void;
}

const NOTHING: StreamWatch = { topics: [], match: "any", agent: null };

const HubContext = createContext<HubContextValue | null>(null);

export function HubStreamProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const listeners = useRef(new Set<HubListener>());
  const [watched, setWatched] = useState<StreamWatch>(NOTHING);
  const url = streamUrl(watched);

  useEffect(() => {
    return connectHub(url, (type, data) => {
      if (type === "resync") {
        router.refresh();
      }
      for (const listener of [...listeners.current]) {
        listener(type, data);
      }
    });
  }, [url, router]);

  const value = useMemo<HubContextValue>(
    () => ({
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => {
          listeners.current.delete(listener);
        };
      },
      watch: (next) => setWatched(next ?? NOTHING)
    }),
    []
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
