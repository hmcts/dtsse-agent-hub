"use client";

import { useEffect, useRef, useState } from "react";

/** How far one press of an arrow key moves the edge. */
const STEP = 40;

export interface ResizableWidth {
  /** The width to render the panel at, in pixels: the width the person chose, as far as the window allows. */
  width: number;
  /** Everything the drag handle needs, so every resizable panel is reached the same way. Spread onto the handle. */
  separator: {
    role: "separator";
    tabIndex: number;
    "aria-orientation": "vertical";
    "aria-label": string;
    "aria-valuenow": number;
    "aria-valuemin": number;
    "aria-valuemax": number | undefined;
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  };
}

/**
 * The width the person last dragged to, or `null`. Storage throws in Safari private browsing and when the quota is
 * full, and a remembered width is never worth breaking the page over.
 */
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * A panel the person drags wider or narrower by its inner edge, at a width their browser remembers.
 *
 * `edge` is the side of the viewport the panel is pinned to; it decides both the pointer arithmetic and which arrow
 * key widens the panel. Home and End go to this panel's own narrowest and widest, whichever side it is pinned to.
 *
 * The width the person chose and the width rendered are two different things. The chosen width changes only when
 * they drag or key the handle; the rendered width is that, fitted to what the window leaves once `reserve(viewport)`
 * pixels are kept for the columns beside it, and never below `min` or above `ceiling`. A window too small for the
 * chosen width therefore shows a fitted one and gives the chosen width back when it grows again, instead of the
 * person losing the width they set. Fitting on the way down cannot be done by clamping the chosen width as the
 * window resizes: `resize` is dispatched before media queries are re-evaluated, so a handler cannot yet tell
 * whether the panel is still one of a row's columns.
 *
 * The remembered width and the viewport are both read in an effect after mount, because neither `localStorage` nor
 * `innerWidth` exists while the server renders and reading either during a render would make the first client render
 * disagree with the server's HTML. The server's width is therefore `initial`, and the handle carries no
 * `aria-valuemax` until the viewport is known.
 *
 * The drag listens on `window`, so it survives the pointer leaving the handle, and writes the width when the drag
 * ends rather than on every frame it passes through. A press that never moves writes nothing.
 */
export function useResizableWidth({
  storageKey,
  label,
  initial,
  min,
  reserve,
  ceiling = Number.POSITIVE_INFINITY,
  edge
}: {
  storageKey: string;
  /** Names the handle for a screen reader, as in "Resize sidebar". */
  label: string;
  initial: number;
  min: number;
  /** Pixels of the window that belong to the rest of the row at that window width, and so are out of reach. */
  reserve: (viewport: number) => number;
  ceiling?: number;
  edge: "left" | "right";
}): ResizableWidth {
  const [chosen, setChosen] = useState(initial);
  const [viewport, setViewport] = useState<number | null>(null);
  const max = viewport === null ? null : Math.max(min, Math.min(ceiling, viewport - reserve(viewport)));
  const width = max === null ? chosen : Math.min(Math.max(chosen, min), max);
  // The pointer and key handlers outlive the render that made them, so they read the bounds from here rather than
  // from their own closure, which a window resized mid-drag would leave behind.
  const bounds = useRef<{ min: number; max: number | null }>({ min, max });

  useEffect(() => {
    bounds.current = { min, max };
  }, [min, max]);

  useEffect(() => {
    const measure = () => setViewport(window.innerWidth);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    const stored = Number(readStored(storageKey));
    if (Number.isFinite(stored) && stored > 0) {
      setChosen(stored);
    }
  }, [storageKey]);

  // A drag still going when the panel goes — the page left mid-drag — is ended with it, so nothing is left listening.
  const endDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => endDrag.current?.(), []);

  function fitted(next: number): number {
    const now = bounds.current;
    return Math.min(Math.max(next, now.min), now.max ?? Number.POSITIVE_INFINITY);
  }

  function remember(next: number): void {
    try {
      window.localStorage.setItem(storageKey, String(next));
    } catch {
      // Not remembered: the width still applies until the page is left, as it would with no storage at all.
    }
  }

  function startResize(event: React.PointerEvent<HTMLElement>): void {
    event.preventDefault();
    let moved = false;
    const move = (pointer: PointerEvent) => {
      moved = true;
      setChosen(fitted(edge === "left" ? pointer.clientX : window.innerWidth - pointer.clientX));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", stop);
      endDrag.current = null;
    };
    const up = () => {
      stop();
      // A press that never moved is not a resize: it must leave the remembered width as it is, and leave a person
      // who has never dragged the handle on whatever the default becomes.
      if (moved) {
        setChosen((current) => {
          remember(current);
          return current;
        });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    // A touch the browser takes back for a scroll or a gesture never sends `pointerup`; without this the panel would
    // go on following a finger that has gone.
    window.addEventListener("pointercancel", stop);
    endDrag.current = stop;
  }

  function resizeByKey(event: React.KeyboardEvent<HTMLElement>): void {
    const towards = edge === "left" ? STEP : -STEP;
    const next =
      event.key === "ArrowRight"
        ? fitted(width + towards)
        : event.key === "ArrowLeft"
          ? fitted(width - towards)
          : event.key === "Home"
            ? min
            : event.key === "End"
              ? bounds.current.max
              : null;
    if (next === null) {
      return;
    }
    event.preventDefault();
    setChosen(next);
    remember(next);
  }

  return {
    width,
    separator: {
      role: "separator",
      tabIndex: 0,
      "aria-orientation": "vertical",
      "aria-label": label,
      "aria-valuenow": width,
      "aria-valuemin": min,
      "aria-valuemax": max ?? undefined,
      onPointerDown: startResize,
      onKeyDown: resizeByKey
    }
  };
}
