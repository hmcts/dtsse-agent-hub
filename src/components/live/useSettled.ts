"use client";

import { useEffect, useRef, useState } from "react";
import { whenOnline } from "@/components/live/connectivity";

/** Long enough to coalesce a burst of changes, such as a session registering and reporting at once. */
export const SETTLE_MS = 250;

export interface Settled {
  /** Runs the callback once the burst this call is part of has settled. */
  settle: () => void;
  /** Drops a run that is settling or waiting for the network, for a caller that has just done the work itself. */
  cancel: () => void;
}

/**
 * Runs `callback` once, `SETTLE_MS` after the first of a burst of `settle` calls, so a burst of stream events costs
 * one read. The run waits for the network, because a read fired into a dead one fails; see `connectivity.ts`. One
 * waiting run covers every call made while the network was down, so those calls start a new settle but add no
 * second run. Unmounting drops whatever is pending, as `cancel` does.
 */
export function useSettled(callback: () => void): Settled {
  const latest = useRef(callback);
  latest.current = callback;
  const [settled] = useState<Settled>(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let waiting: (() => void) | null = null;
    return {
      settle: () => {
        if (timer !== null) {
          return;
        }
        timer = setTimeout(() => {
          timer = null;
          if (waiting === null) {
            waiting = whenOnline(() => {
              waiting = null;
              latest.current();
            });
          }
        }, SETTLE_MS);
      },
      cancel: () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        waiting?.();
        waiting = null;
      }
    };
  });
  useEffect(() => settled.cancel, [settled]);
  return settled;
}
