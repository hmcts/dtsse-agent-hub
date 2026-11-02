"use client";

import { useEffect, useRef } from "react";
import { whenOnline } from "@/components/live/connectivity";

/** Long enough to coalesce a burst of changes, such as a session registering and reporting at once. */
export const SETTLE_MS = 250;

/**
 * A trigger that runs `callback` once, `SETTLE_MS` after the first of a burst of calls, so a burst of stream events
 * costs one read. The run waits for the network, because a read fired into a dead one fails; see `connectivity.ts`.
 * One waiting run covers every call made while the network was down, so those calls start a new settle but add no
 * second run. Unmounting drops a settle or a wait still pending.
 */
export function useSettled(callback: () => void): () => void {
  const latest = useRef(callback);
  latest.current = callback;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waiting = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      waiting.current?.();
      waiting.current = null;
    },
    []
  );
  const trigger = useRef(() => {
    if (timer.current !== null) {
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      if (waiting.current === null) {
        waiting.current = whenOnline(() => {
          waiting.current = null;
          latest.current();
        });
      }
    }, SETTLE_MS);
  });
  return trigger.current;
}
