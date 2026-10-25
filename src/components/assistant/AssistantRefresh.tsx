"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { whenOnline } from "@/components/live/connectivity";
import { useHubEvent } from "@/components/live/HubStream";

/** Coalesces a burst of changes, such as a session registering and reporting at once, into one re-render. */
const SETTLE_MS = 250;

/**
 * Re-renders the Assistant's server components when the viewer's assistant or one of their conversations changes:
 * the events carry only ids, so the page reads what changed itself.
 *
 * The settled refresh waits for the network, because refreshing without one takes the page to the error boundary;
 * see `live/connectivity.ts`. One waiting refresh covers every event that arrived while the network was down, so
 * events during the wait restart the debounce but add no second refresh.
 */
export function AssistantRefresh() {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waiting = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
      waiting.current?.();
      waiting.current = null;
    },
    []
  );
  const refresh = () => {
    if (timer.current === null) {
      timer.current = setTimeout(() => {
        timer.current = null;
        if (waiting.current === null) {
          waiting.current = whenOnline(() => {
            waiting.current = null;
            router.refresh();
          });
        }
      }, SETTLE_MS);
    }
  };
  useHubEvent("assistant_conversation", refresh);
  useHubEvent("virtual_agent", refresh);
  return null;
}
