"use client";

import { type RefObject, useEffect } from "react";

/**
 * Closes an open menu on Escape or on a mouse press outside `container`, the way every menu in the sidebar is
 * dismissed. `close` decides where focus goes: back to the trigger from the keyboard, left where a click put it. It
 * is told which it was, since a click outside lands while focus is still inside, before the browser moves it.
 */
export function useDismiss(open: boolean, container: RefObject<HTMLElement | null>, close: (how: "keyboard" | "pointer") => void): void {
  useEffect(() => {
    if (!open) {
      return;
    }
    const dismiss = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") {
          // Escape dismisses the innermost thing only. The shell closes its drawer on Escape from `window`, which is
          // the next stop after `document`, so a menu would otherwise take the whole sidebar with it.
          event.stopPropagation();
          close("keyboard");
        }
        return;
      }
      if (!container.current?.contains(event.target as Node)) {
        close("pointer");
      }
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, [open, container, close]);
}
