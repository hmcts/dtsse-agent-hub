/**
 * The widget's own layer over the prototype: one host element with a closed shadow root, so the prototype's styles
 * and scripts cannot reach in and the widget's cannot leak out. Styles are set through the CSSOM rather than a
 * `<style>` or `style=""`, which a prototype's `style-src` would block.
 *
 * The host is a zero-sized fixed box on `<html>`, outside `<body>`, so a framework that replaces the body keeps it,
 * and an rrweb snapshot, which blocks it, records a placeholder of no size rather than a viewport-sized hole.
 */

export const LAYER_ATTRIBUTE = "data-agent-hub-feedback";

export interface Layer {
  host: HTMLElement;
  root: ShadowRoot;
}

export type Style = Partial<Record<keyof CSSStyleDeclaration, string>>;

export function styled<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K, style: Style): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  Object.assign(element.style, style);
  return element;
}

export function createLayer(document: Document): Layer {
  const host = styled(document, "div", {
    all: "initial",
    position: "fixed",
    top: "0",
    left: "0",
    width: "0",
    height: "0",
    overflow: "visible",
    zIndex: "2147483647"
  });
  host.setAttribute(LAYER_ATTRIBUTE, "");
  const root = host.attachShadow({ mode: "closed" });
  document.documentElement.appendChild(host);
  return { host, root };
}

/** Whether `node` is the widget's own, which picking and markers never treat as the prototype's. */
export function isOwn(node: EventTarget | null, layer: Layer): boolean {
  return node === layer.host || (node instanceof Node && layer.host.contains(node));
}

export const FOCUS_YELLOW = "#ffdd00";
export const INK = "#0b0c0c";
export const BLUE = "#1d70b8";
