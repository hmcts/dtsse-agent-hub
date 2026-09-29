"use client";

import { useEffect, useState } from "react";

export const TICK_MS = 30_000;

type Listener = (now: number) => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | undefined;

/** One interval for the whole tab however many times are on screen, running only while one is mounted. */
function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    timer = setInterval(() => {
      const now = Date.now();
      for (const each of [...listeners]) {
        each(now);
      }
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/**
 * The current time, ticking every `TICK_MS`, or `null` until the component has mounted. The server has no reader's
 * clock to agree with, so the first render, the one hydration compares with the server's HTML, must not depend on it.
 */
export function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    return subscribe(setNow);
  }, []);
  return now;
}
