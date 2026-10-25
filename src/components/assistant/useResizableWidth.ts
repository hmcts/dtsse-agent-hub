"use client";

import { useEffect, useState } from "react";

/** How far one press of an arrow key moves the edge. */
const STEP = 40;

export interface ResizableWidth {
  /** The width to render the panel at, in pixels. */
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
 * A panel the person drags wider or narrower by its inner edge, at a width their browser remembers.
 *
 * `edge` is the side of the viewport the panel is pinned to; it decides both the pointer arithmetic and which arrow
 * key widens the panel. The width never falls below `min` or rises above `ceiling`, nor above what the viewport
 * leaves once `reserve` pixels are kept for the columns beside it. Home and End go to this panel's own narrowest
 * and widest, whichever side it is pinned to.
 *
 * The remembered width and the viewport are both read in an effect after mount, because neither `localStorage` nor
 * `innerWidth` exists while the server renders and reading either during a render would make the first client render
 * disagree with the server's HTML. The server's width is therefore `initial`, and the handle carries no
 * `aria-valuemax` until the viewport is known.
 *
 * The drag listens on `window`, so it survives the pointer leaving the handle, and writes the width when the drag
 * ends rather than on every frame it passes through.
 */
export function useResizableWidth({
  storageKey,
  label,
  initial,
  min,
  reserve,
  ceiling = Number.POSITIVE_INFINITY,
  edge,
  active = true
}: {
  storageKey: string;
  /** Names the handle for a screen reader, as in "Resize sidebar". */
  label: string;
  initial: number;
  min: number;
  /** Pixels of the viewport that belong to the rest of the row, and so are out of this panel's reach. */
  reserve: number;
  ceiling?: number;
  edge: "left" | "right";
  /** False while the panel is not one of a row's columns, as on a narrow screen, where its width means nothing. */
  active?: boolean;
}): ResizableWidth {
  const [width, setWidth] = useState(initial);
  const [viewport, setViewport] = useState<number | null>(null);
  const max = viewport === null ? null : Math.max(min, Math.min(ceiling, viewport - reserve));

  useEffect(() => {
    const measure = () => setViewport(window.innerWidth);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    const stored = Number(window.localStorage.getItem(storageKey));
    if (Number.isFinite(stored) && stored > 0) {
      setWidth(stored);
    }
  }, [storageKey]);

  // A width remembered from a wider window, or room since taken by the panel beside this one, is brought back in
  // bounds. Only ever narrower: a panel is never pushed wider than the person left it. A panel that is not in the
  // row keeps its width, so a visit to a narrow screen does not cost the person the width they dragged.
  useEffect(() => {
    if (active && max !== null) {
      setWidth((current) => Math.min(Math.max(current, min), max));
    }
  }, [active, max, min]);

  function clamp(next: number): number {
    return Math.min(Math.max(next, min), max ?? Number.POSITIVE_INFINITY);
  }

  function remember(next: number): void {
    window.localStorage.setItem(storageKey, String(next));
  }

  function startResize(event: React.PointerEvent<HTMLElement>): void {
    event.preventDefault();
    const move = (moved: PointerEvent) => setWidth(clamp(edge === "left" ? moved.clientX : window.innerWidth - moved.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setWidth((current) => {
        remember(current);
        return current;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function resizeByKey(event: React.KeyboardEvent<HTMLElement>): void {
    const towards = edge === "left" ? STEP : -STEP;
    const next =
      event.key === "ArrowRight"
        ? clamp(width + towards)
        : event.key === "ArrowLeft"
          ? clamp(width - towards)
          : event.key === "Home"
            ? min
            : event.key === "End"
              ? max
              : null;
    if (next === null) {
      return;
    }
    event.preventDefault();
    setWidth(next);
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
