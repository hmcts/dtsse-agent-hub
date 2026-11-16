import { FOCUS_YELLOW, INK, isOwn, type Layer, styled } from "./layer.ts";

/**
 * Choosing the element a comment is about. The pointer highlights what it is over and a click chooses it; from the
 * keyboard, Tab and Shift+Tab move the highlight through the page's focusable and text-bearing elements and Enter
 * chooses. Escape cancels either way. While picking, every pointer and key event is taken in the capture phase on
 * the window, before the prototype's own handlers, so choosing a button does not also press it.
 */

export interface PickHandlers {
  onPick: (element: Element) => void;
  onCancel: () => void;
}

const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function bearsText(element: Element): boolean {
  for (const child of element.childNodes) {
    if (child.nodeType === 3 && (child.textContent ?? "").trim() !== "") {
      return true;
    }
  }
  return false;
}

export function isVisible(element: Element): boolean {
  return element.getClientRects().length > 0;
}

/** The elements keyboard picking steps through, in document order. */
export function pickCandidates(document: Document, layer: Layer, visible: (element: Element) => boolean = isVisible): Element[] {
  const body = document.body;
  if (body === null) {
    return [];
  }
  return Array.from(body.querySelectorAll("*")).filter(
    (element) => !isOwn(element, layer) && (element.matches(FOCUSABLE) || bearsText(element)) && visible(element)
  );
}

/** The step after `current` through `candidates`, wrapping, backwards for Shift+Tab. */
export function nextCandidate(candidates: readonly Element[], current: Element | undefined, backwards: boolean): Element | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  const at = current === undefined ? -1 : candidates.indexOf(current);
  if (at === -1) {
    return backwards ? candidates[candidates.length - 1] : candidates[0];
  }
  const next = (at + (backwards ? -1 : 1) + candidates.length) % candidates.length;
  return candidates[next];
}

const BLOCKED = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick", "touchstart", "touchend", "submit"] as const;

/** Starts picking, and answers the function that stops it without choosing. */
export function startPicking(view: Window, layer: Layer, handlers: PickHandlers, visible: (element: Element) => boolean = isVisible): () => void {
  const { document } = view;
  const box = styled(document, "div", {
    position: "fixed",
    pointerEvents: "none",
    boxSizing: "border-box",
    border: `3px solid ${FOCUS_YELLOW}`,
    outline: `2px solid ${INK}`,
    display: "none"
  });
  const label = styled(document, "div", {
    position: "fixed",
    pointerEvents: "none",
    background: INK,
    color: "#ffffff",
    font: "600 12px/1.4 system-ui, sans-serif",
    padding: "2px 6px",
    display: "none"
  });
  const banner = styled(document, "div", {
    position: "fixed",
    top: "8px",
    left: "50%",
    transform: "translateX(-50%)",
    pointerEvents: "none",
    background: INK,
    color: "#ffffff",
    font: "14px/1.4 system-ui, sans-serif",
    padding: "6px 12px",
    borderRadius: "4px"
  });
  banner.setAttribute("role", "status");
  banner.textContent = "Choose what to comment on: click it, or press Tab to move and Enter to choose. Escape cancels.";
  layer.root.append(box, label, banner);

  let current: Element | undefined;
  let frame = 0;

  const draw = () => {
    frame = 0;
    if (current === undefined || !current.isConnected) {
      box.style.display = "none";
      label.style.display = "none";
      return;
    }
    const rect = current.getBoundingClientRect();
    Object.assign(box.style, { display: "block", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    label.textContent = current.localName;
    Object.assign(label.style, { display: "block", left: `${rect.left}px`, top: `${Math.max(0, rect.top - 22)}px` });
  };
  const highlight = (element: Element | undefined) => {
    current = element;
    if (frame === 0) {
      frame = view.requestAnimationFrame(draw);
    }
  };

  const swallow = (event: Event) => {
    if (isOwn(event.target, layer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  const onMove = (event: Event) => {
    const target = event.target;
    if (target instanceof Element && !isOwn(target, layer)) {
      highlight(target);
    }
  };
  const onBlocked = (event: Event) => {
    swallow(event);
    if (event.type === "click" && event.target instanceof Element && !isOwn(event.target, layer)) {
      finish();
      handlers.onPick(event.target);
    }
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      swallow(event);
      finish();
      handlers.onCancel();
    } else if (event.key === "Tab") {
      swallow(event);
      const next = nextCandidate(pickCandidates(document, layer, visible), current, event.shiftKey);
      next?.scrollIntoView?.({ block: "nearest" });
      highlight(next);
    } else if (event.key === "Enter" || event.key === " ") {
      swallow(event);
      if (current !== undefined) {
        const chosen = current;
        finish();
        handlers.onPick(chosen);
      }
    }
  };

  const reposition = () => highlight(current);

  const finish = () => {
    view.removeEventListener("mousemove", onMove, true);
    view.removeEventListener("pointerover", onMove, true);
    for (const type of BLOCKED) {
      view.removeEventListener(type, onBlocked, true);
    }
    view.removeEventListener("keydown", onKey, true);
    view.removeEventListener("scroll", reposition, true);
    view.removeEventListener("resize", reposition);
    if (frame !== 0) {
      view.cancelAnimationFrame(frame);
    }
    box.remove();
    label.remove();
    banner.remove();
  };

  view.addEventListener("mousemove", onMove, true);
  view.addEventListener("pointerover", onMove, true);
  for (const type of BLOCKED) {
    view.addEventListener(type, onBlocked, true);
  }
  view.addEventListener("keydown", onKey, true);
  view.addEventListener("scroll", reposition, { capture: true, passive: true });
  view.addEventListener("resize", reposition);
  const active = document.activeElement;
  if (active !== null && active !== document.body && !isOwn(active, layer)) {
    highlight(active);
  }
  return finish;
}
