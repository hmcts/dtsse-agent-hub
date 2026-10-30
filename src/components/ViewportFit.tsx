"use client";

import { useEffect } from "react";

/**
 * Keeps the page the height of what can be seen when a phone's on-screen keyboard is up.
 *
 * The page fills the window and does not scroll (`body` is `overflow: hidden`), so its top bar sits at the top of the
 * window's own height. A keyboard shrinks the visible area but, on iOS Safari, not the window: the browser pans the
 * page up to keep the focused field in view, and the top bar and the sidebar button go off the top with nothing to
 * scroll back with. So the height is taken from the visual viewport instead, and a pan the browser makes is undone.
 *
 * It writes `--app-height` on the root element, which `globals.css` gives `html` and `body`; without it, or before
 * this has run, they are `100dvh`. Nothing is rendered.
 */
export function ViewportFit() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (viewport === null) {
      return;
    }
    const root = document.documentElement;
    const adjust = () => {
      // Pinching in shrinks the visual viewport too, and that is the person looking closer, not a keyboard: leave the
      // layout and the page's own panning alone until they zoom back out.
      if (viewport.scale > 1.01) {
        root.style.removeProperty("--app-height");
        return;
      }
      root.style.setProperty("--app-height", `${Math.round(viewport.height)}px`);
      // The browser panned the page to show the focused field; the layout is already the visible height, so put it back.
      if (window.scrollY !== 0 || viewport.offsetTop !== 0) {
        window.scrollTo(0, 0);
      }
    };
    adjust();
    viewport.addEventListener("resize", adjust);
    viewport.addEventListener("scroll", adjust);
    return () => {
      viewport.removeEventListener("resize", adjust);
      viewport.removeEventListener("scroll", adjust);
      root.style.removeProperty("--app-height");
    };
  }, []);
  return null;
}
