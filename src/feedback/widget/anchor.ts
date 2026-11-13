import type { WidgetAnchor } from "../protocol.ts";
import { selectorFor } from "./selector.ts";

/**
 * Pinning a comment to an element, and finding the element again: by its selector while the text still agrees, and
 * failing that by its tag and text, nearest to where it was. An element found neither way is reported detached.
 */

export const MAX_ANCHOR_TEXT = 120;

/** What the element says, whitespace collapsed, cut to `MAX_ANCHOR_TEXT`: what a person would recognise it by. */
export function textSnippet(element: Element): string {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_ANCHOR_TEXT);
}

const TAG = /^[a-z][a-z0-9-]{0,40}$/;

/**
 * The element a comment is pinned to: the one picked, or its nearest ancestor with a tag the anchor's schema takes,
 * since an SVG part such as `foreignObject` or a namespaced tag has none.
 */
export function anchorTarget(element: Element): Element {
  let node: Element | null = element;
  while (node !== null && !TAG.test(node.localName)) {
    node = node.parentElement;
  }
  return node ?? element;
}

/** Where `element` is now, in the page's coordinates, and how big the viewport is. */
export function anchorFor(element: Element, view: Window): WidgetAnchor {
  const target = anchorTarget(element);
  const box = target.getBoundingClientRect();
  return {
    selector: selectorFor(target),
    text: textSnippet(target),
    tag: target.localName,
    rect: { x: box.left + view.scrollX, y: box.top + view.scrollY, width: Math.max(0, box.width), height: Math.max(0, box.height) },
    viewport: { width: Math.max(1, Math.round(view.innerWidth)), height: Math.max(1, Math.round(view.innerHeight)) }
  };
}

function bySelector(document: Document, selector: string): Element | null {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

function distance(element: Element, anchor: WidgetAnchor, view: Window | null): number {
  const box = element.getBoundingClientRect();
  const x = box.left + (view?.scrollX ?? 0);
  const y = box.top + (view?.scrollY ?? 0);
  return Math.hypot(x - anchor.rect.x, y - anchor.rect.y);
}

/** The element `anchor` was taken from, on the page as it is now, or `undefined` when it cannot be told apart. */
export function findAnchored(document: Document, anchor: WidgetAnchor): Element | undefined {
  const found = bySelector(document, anchor.selector);
  if (found !== null && textSnippet(found) === anchor.text) {
    return found;
  }
  if (anchor.text === "" || !TAG.test(anchor.tag)) {
    return undefined;
  }
  const candidates = Array.from(document.getElementsByTagName(anchor.tag)).filter((element) => textSnippet(element) === anchor.text);
  if (candidates.length === 0) {
    return undefined;
  }
  const view = document.defaultView;
  return candidates.reduce((best, candidate) => (distance(candidate, anchor, view) < distance(best, anchor, view) ? candidate : best));
}
