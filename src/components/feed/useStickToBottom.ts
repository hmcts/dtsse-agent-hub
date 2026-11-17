"use client";

import { useLayoutEffect, useRef } from "react";

/** How near the bottom, in pixels, still counts as reading the latest messages. */
const STICK_DISTANCE = 80;

/**
 * Keeps a scrolling list pinned to its newest entry while the reader is at the bottom, as a chat does, and leaves
 * it alone once they scroll up to read older ones. `content` is whatever changes when entries arrive.
 */
export function useStickToBottom<T extends HTMLElement>(content: unknown) {
  const ref = useRef<T>(null);
  const stick = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect must re-run when the entries change, which it does not read
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && stick.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [content]);
  function onScroll(): void {
    const element = ref.current;
    if (element) {
      stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_DISTANCE;
    }
  }
  /**
   * Follows the newest entry again whatever the reader was doing, and goes there now: for an action of their own,
   * such as sending, whose result they expect to see.
   */
  function stickNow(): void {
    stick.current = true;
    const element = ref.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }
  return { ref, onScroll, stickNow };
}
