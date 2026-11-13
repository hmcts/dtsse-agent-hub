import { isShellMessage, type RecordedEvent, type ShellMessage, type WidgetMessageBody, widgetMessage } from "../protocol.ts";
import { anchorFor } from "./anchor.ts";
import { createLayer, type Layer } from "./layer.ts";
import { type FrameContext, installLinkCapture, pagePathOf } from "./links.ts";
import { createMarkers, type Markers } from "./markers.ts";
import { startPicking } from "./picker.ts";
import { createRecorder, type Recorder, type RecordFunction } from "./recorder.ts";

/**
 * The widget in one framed page: it tells the shell where the frame is, picks and snapshots elements, draws the
 * thread markers and records while asked to. It does nothing outside a frame, and talks only to its parent, at the
 * hub's origin, accepting only what its parent sends from there.
 */

export interface WidgetConfig {
  hubOrigin: string;
  prefix: string;
  upstreamOrigin: string;
  maskInputs: boolean;
  version: string;
}

/** The configuration from the widget's own `<script>` tag, or `undefined` when it is not the proxy's. */
export function configFrom(script: Element | null): WidgetConfig | undefined {
  const hubOrigin = script?.getAttribute("data-hub-origin");
  const prefix = script?.getAttribute("data-prefix");
  const upstreamOrigin = script?.getAttribute("data-upstream-origin");
  if (!hubOrigin || !prefix || !upstreamOrigin || !URL.canParse(hubOrigin) || !URL.canParse(upstreamOrigin)) {
    return undefined;
  }
  return {
    hubOrigin: new URL(hubOrigin).origin,
    prefix,
    upstreamOrigin: new URL(upstreamOrigin).origin,
    maskInputs: script?.getAttribute("data-mask-inputs") === "true",
    version: script?.getAttribute("data-version") ?? ""
  };
}

export interface RunningWidget {
  layer: Layer;
  markers: Markers;
  recorder: Recorder;
  stop: () => void;
}

export function startWidget(view: Window, config: WidgetConfig, record: RecordFunction): RunningWidget | undefined {
  const parent = view.parent;
  if (parent === view) {
    return undefined;
  }
  const { document } = view;
  const context: FrameContext = { prefix: config.prefix, upstreamOrigin: config.upstreamOrigin, frameOrigin: view.location.origin };
  const post = (body: WidgetMessageBody) => parent.postMessage(widgetMessage(body), config.hubOrigin);
  const path = () => pagePathOf(view.location, config.prefix);

  const layer = createLayer(document);
  const markers = createMarkers(view, layer, {
    onClick: (id) => post({ type: "marker-clicked", id }),
    onDetached: (ids) => post({ type: "detached", ids })
  });
  const recorder = createRecorder(record, (events: RecordedEvent[]) => post({ type: "replay-events", path: path(), events }));
  let stopPicking: (() => void) | undefined;
  let lastPath = path();

  const navigated = () => {
    const now = path();
    if (now !== lastPath) {
      lastPath = now;
      // The events so far belong to the page being left, so they go before the shell hears of the new one.
      recorder.flush();
      post({ type: "navigated", path: now });
    }
  };

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== config.hubOrigin || event.source !== parent || !isShellMessage(event.data)) {
      return;
    }
    handle(event.data);
  };
  const handle = (message: ShellMessage) => {
    switch (message.type) {
      case "pick-start":
        stopPicking?.();
        view.focus();
        stopPicking = startPicking(view, layer, {
          onPick: (element) => {
            stopPicking = undefined;
            post({ type: "picked", path: path(), anchor: anchorFor(element, view), snapshot: recorder.snapshot(config.maskInputs) });
          },
          onCancel: () => {
            stopPicking = undefined;
            post({ type: "pick-cancel" });
          }
        });
        break;
      case "pick-cancel":
        stopPicking?.();
        stopPicking = undefined;
        break;
      case "markers":
        markers.set(message.threads);
        break;
      case "focus-thread":
        markers.focus(message.id);
        break;
      case "record-start":
        recorder.start(message.maskInputs);
        break;
      case "record-stop":
        recorder.stop();
        break;
    }
  };

  const history = view.history;
  const originalPush = history.pushState;
  const originalReplace = history.replaceState;
  history.pushState = function pushState(this: History, ...args: Parameters<History["pushState"]>) {
    originalPush.apply(this, args);
    navigated();
  };
  history.replaceState = function replaceState(this: History, ...args: Parameters<History["replaceState"]>) {
    originalReplace.apply(this, args);
    navigated();
  };
  const onPageHide = () => recorder.flush();
  // Ahead of `pagehide` as well: a message posted from `pagehide` reaches the shell after the frame's next document
  // has replaced this one, with a `null` `event.source` the shell rightly refuses, which would lose the click that
  // left the page. `beforeunload` fires while this document is still the frame's, so its batch arrives as the frame's.
  const onBeforeUnload = () => recorder.flush();
  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      recorder.flush();
    }
  };

  view.addEventListener("message", onMessage);
  view.addEventListener("popstate", navigated);
  view.addEventListener("beforeunload", onBeforeUnload);
  view.addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", onVisibility);
  const stopLinks = installLinkCapture(view, context);
  post({ type: "hello", path: lastPath, title: document.title, version: config.version });

  return {
    layer,
    markers,
    recorder,
    stop: () => {
      stopPicking?.();
      recorder.stop();
      markers.destroy();
      stopLinks();
      history.pushState = originalPush;
      history.replaceState = originalReplace;
      view.removeEventListener("message", onMessage);
      view.removeEventListener("popstate", navigated);
      view.removeEventListener("beforeunload", onBeforeUnload);
      view.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      layer.host.remove();
    }
  };
}
