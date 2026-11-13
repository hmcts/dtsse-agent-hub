import type { MarkerThread } from "../protocol.ts";
import { findAnchored } from "./anchor.ts";
import { BLUE, FOCUS_YELLOW, INK, type Layer, styled } from "./layer.ts";

/**
 * A numbered marker beside each thread's element, kept beside it as the page scrolls, resizes and changes. Each is a
 * button named "Comment N" that shows its number, so it is told apart by more than colour, and clicking one asks the
 * shell to open its card. A thread whose element cannot be found is reported detached, once the page has had a
 * moment to render it: a single-page app often draws its content after the widget starts.
 */

export interface MarkerHandlers {
  onClick: (id: string) => void;
  onDetached: (ids: string[]) => void;
}

export interface Markers {
  set: (threads: readonly MarkerThread[]) => void;
  focus: (id: string) => void;
  destroy: () => void;
}

/** How long a thread has to stay unfound before it is reported detached. */
export const DETACH_SETTLE_MS = 1500;
const MARKER_SIZE = 24;
const FLASH_MS = 2000;

export function createMarkers(view: Window, layer: Layer, handlers: MarkerHandlers): Markers {
  const { document } = view;
  const container = styled(document, "div", { position: "fixed", top: "0", left: "0", width: "0", height: "0" });
  const flash = styled(document, "div", {
    position: "fixed",
    pointerEvents: "none",
    boxSizing: "border-box",
    border: `3px solid ${FOCUS_YELLOW}`,
    outline: `2px solid ${INK}`,
    display: "none"
  });
  layer.root.append(container, flash);

  let threads: readonly MarkerThread[] = [];
  const buttons = new Map<string, HTMLButtonElement>();
  let focused: string | undefined;
  let reported = "";
  let frame = 0;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let flashing: Element | undefined;

  const button = (thread: MarkerThread): HTMLButtonElement => {
    const existing = buttons.get(thread.id);
    if (existing !== undefined) {
      return existing;
    }
    const made = styled(document, "button", {
      position: "fixed",
      width: `${MARKER_SIZE}px`,
      height: `${MARKER_SIZE}px`,
      borderRadius: "50%",
      border: "2px solid #ffffff",
      boxShadow: `0 0 0 1px ${INK}`,
      color: "#ffffff",
      font: "700 12px/1 system-ui, sans-serif",
      padding: "0",
      margin: "0",
      cursor: "pointer",
      pointerEvents: "auto"
    });
    made.type = "button";
    made.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      handlers.onClick(thread.id);
    });
    made.addEventListener("focus", () => (made.style.outline = `3px solid ${FOCUS_YELLOW}`));
    made.addEventListener("blur", () => (made.style.outline = thread.id === focused ? `3px solid ${FOCUS_YELLOW}` : "none"));
    buttons.set(thread.id, made);
    container.append(made);
    return made;
  };

  const missing = (): string[] => threads.filter((thread) => findAnchored(document, thread.anchor) === undefined).map((thread) => thread.id);

  const report = () => {
    settle = undefined;
    const ids = missing();
    const key = ids.join(",");
    if (key !== reported) {
      reported = key;
      handlers.onDetached(ids);
    }
  };

  const layout = () => {
    frame = 0;
    const width = view.innerWidth;
    const lost: string[] = [];
    for (const thread of threads) {
      const marker = button(thread);
      const element = findAnchored(document, thread.anchor);
      if (element === undefined) {
        marker.style.display = "none";
        lost.push(thread.id);
        continue;
      }
      const rect = element.getBoundingClientRect();
      const left = Math.min(Math.max(0, rect.right - MARKER_SIZE / 2), Math.max(0, width - MARKER_SIZE));
      const top = Math.max(0, rect.top - MARKER_SIZE / 2);
      marker.textContent = String(thread.number);
      marker.setAttribute("aria-label", `Comment ${thread.number}${thread.status === "resolved" ? ", resolved" : ""}`);
      Object.assign(marker.style, {
        display: "block",
        left: `${left}px`,
        top: `${top}px`,
        background: thread.status === "resolved" ? "#505a5f" : BLUE,
        outline: thread.id === focused ? `3px solid ${FOCUS_YELLOW}` : "none"
      });
    }
    if (flashing !== undefined) {
      const rect = flashing.getBoundingClientRect();
      Object.assign(flash.style, { display: "block", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    }
    if (lost.join(",") !== reported && settle === undefined) {
      settle = setTimeout(report, DETACH_SETTLE_MS);
    }
  };

  const schedule = () => {
    if (frame === 0) {
      frame = view.requestAnimationFrame(layout);
    }
  };

  const observer = new (view as Window & typeof globalThis).MutationObserver(schedule);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  view.addEventListener("scroll", schedule, { capture: true, passive: true });
  view.addEventListener("resize", schedule);

  return {
    set: (next) => {
      const keep = new Set(next.map((thread) => thread.id));
      for (const [id, marker] of buttons) {
        if (!keep.has(id)) {
          marker.remove();
          buttons.delete(id);
        }
      }
      threads = [...next];
      schedule();
    },
    focus: (id) => {
      focused = id;
      const thread = threads.find((candidate) => candidate.id === id);
      const element = thread === undefined ? undefined : findAnchored(document, thread.anchor);
      schedule();
      if (element === undefined) {
        return;
      }
      element.scrollIntoView?.({ block: "center", behavior: "smooth" });
      flashing = element;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        flashing = undefined;
        flash.style.display = "none";
      }, FLASH_MS);
    },
    destroy: () => {
      observer.disconnect();
      view.removeEventListener("scroll", schedule, true);
      view.removeEventListener("resize", schedule);
      if (frame !== 0) {
        view.cancelAnimationFrame(frame);
      }
      clearTimeout(settle);
      clearTimeout(flashTimer);
      container.remove();
      flash.remove();
    }
  };
}
