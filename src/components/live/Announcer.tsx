"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** How long arrivals are gathered before they are read out, so a burst is one announcement rather than several. */
export const ANNOUNCE_AFTER_MS = 1000;

/**
 * What a batch of arrivals reads as: the one arrival's own sentence, or a count when several came together.
 * `noun` is the plural used for the count, "posts" or "messages".
 */
export function arrivalText(arrivals: readonly string[], noun: string): string {
  return arrivals.length > 1 ? `${arrivals.length} new ${noun}` : arrivals.join("");
}

/**
 * Announces live arrivals to a screen reader. The feed itself is not a live region, because loading a page of older
 * posts would read the whole page out; the view calls `announce` for each new arrival instead, and `AnnouncerRegion`
 * reads the batch. The region is emptied when a new batch starts, so the same sentence twice is read twice.
 */
export function useAnnouncer(noun: string): { text: string; announce: (arrival: string) => void } {
  const [text, setText] = useState("");
  const pending = useRef<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    []
  );

  const announce = useCallback(
    (arrival: string) => {
      pending.current.push(arrival);
      if (timer.current !== null) {
        return;
      }
      setText("");
      timer.current = setTimeout(() => {
        timer.current = null;
        setText(arrivalText(pending.current, noun));
        pending.current = [];
      }, ANNOUNCE_AFTER_MS);
    },
    [noun]
  );

  return { text, announce };
}

export function AnnouncerRegion({ text }: { text: string }) {
  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only" data-testid="arrivals">
      {text}
    </div>
  );
}
