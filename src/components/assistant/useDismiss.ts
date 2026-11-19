"use client";

import { type RefObject, useEffect } from "react";

/**
 * Closes an open menu on Escape or on a mouse press outside `container`, the way every menu in the sidebar is
 * dismissed. `close` puts focus back on the trigger when focus is in the menu; a click outside is left to put it where
 * the person clicked.
 */
export function useDismiss(open: boolean, container: RefObject<HTMLElement | null>, close: () => void): void {
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
          close();
        }
        return;
      }
      if (!container.current?.contains(event.target as Node)) {
        // A press lands while focus is still in the menu, before the browser moves it to where the press was, so
        // every closer would read it as the keyboard and pull focus back to its trigger. Letting go of it first leaves
        // the press to place it.
        if (document.activeElement instanceof HTMLElement && container.current?.contains(document.activeElement)) {
          document.activeElement.blur();
        }
        close();
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
