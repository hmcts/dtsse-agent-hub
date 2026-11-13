"use client";

import type { Replayer } from "@rrweb/replay";
import { useEffect, useRef, useState } from "react";
import { gunzipJson } from "@/feedback/playback";
import type { FeedbackAnchor } from "@/feedback/schemas";
import type { FeedbackThreadView } from "@/feedback/thread-store";

/**
 * The page a thread was raised on, rebuilt from the snapshot the widget took with it, scaled to fit, with the element
 * the thread is pinned to outlined. The replayer's frame is sandboxed with scripts off (`UNSAFE_replayCanvas` is
 * what would turn them on), so nothing of the prototype runs here: it is the page's DOM and styles, and no more.
 */

type ReplayEvent = Exclude<ConstructorParameters<typeof Replayer>[0][number], string>;

/** Where the outline is, in the view's own pixels, for a caller drawing a line from it to the thread's card. */
export interface Highlight {
  top: number;
  left: number;
  width: number;
  height: number;
  /** The element was not found in the snapshot, so this is where it was when the comment was made. */
  approximate: boolean;
}

type State = { phase: "loading" } | { phase: "none" } | { phase: "failed"; message: string } | { phase: "shown"; highlight: Highlight | null };

/** The element a thread is pinned to: by its selector, or else by its tag and the start of its text. */
export function findAnchor(doc: Document, anchor: Pick<FeedbackAnchor, "selector" | "tag" | "text">): Element | null {
  try {
    const found = doc.querySelector(anchor.selector);
    if (found !== null) {
      return found;
    }
  } catch {
    // A selector the snapshot's document cannot parse falls through to the text match.
  }
  const text = anchor.text.trim().slice(0, 80);
  if (text === "") {
    return null;
  }
  return [...doc.getElementsByTagName(anchor.tag)].find((element) => (element.textContent ?? "").trim().includes(text)) ?? null;
}

async function loadSnapshot(projectId: string, threadId: string): Promise<ReplayEvent[] | null> {
  const answer = await fetch(`/api/ui/feedback/projects/${projectId}/threads/${threadId}/snapshot`);
  if (answer.status === 404) {
    return null;
  }
  if (!answer.ok) {
    throw new Error("the snapshot could not be read");
  }
  const { url } = (await answer.json()) as { url: string };
  const blob = await fetch(url);
  if (!blob.ok) {
    throw new Error("the snapshot could not be downloaded");
  }
  return await gunzipJson<ReplayEvent>(await blob.arrayBuffer());
}

export function SnapshotView({
  projectId,
  thread,
  onHighlight
}: Readonly<{ projectId: string; thread: Pick<FeedbackThreadView, "id" | "anchor" | "snapshotBlob">; onHighlight?: (highlight: Highlight | null) => void }>) {
  const box = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>(thread.snapshotBlob === null ? { phase: "none" } : { phase: "loading" });
  const [width, setWidth] = useState(0);
  const { viewport } = thread.anchor;
  const scale = width > 0 ? Math.min(1, width / viewport.width) : 1;
  const latestHighlight = useRef(onHighlight);
  latestHighlight.current = onHighlight;
  const anchor = useRef(thread.anchor);
  anchor.current = thread.anchor;
  // The anchor by value: a page re-read hands the same anchor back as a new object, which is no reason to rebuild.
  const anchorKey = JSON.stringify(thread.anchor);

  useEffect(() => {
    const element = box.current;
    if (element === null || typeof ResizeObserver === "undefined") {
      setWidth(element?.clientWidth ?? 0);
      return;
    }
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuilt when the anchor changes by value, which `anchorKey` is
  useEffect(() => {
    if (thread.snapshotBlob === null) {
      setState({ phase: "none" });
      latestHighlight.current?.(null);
      return;
    }
    let live = true;
    let replayer: Replayer | undefined;
    setState({ phase: "loading" });
    (async () => {
      const events = await loadSnapshot(projectId, thread.id);
      if (!live) {
        return;
      }
      if (events === null || events.length === 0 || stage.current === null) {
        setState({ phase: "none" });
        return;
      }
      const { Replayer } = await import("@rrweb/replay");
      if (!live || stage.current === null) {
        return;
      }
      stage.current.replaceChildren();
      replayer = new Replayer(events, {
        root: stage.current,
        UNSAFE_replayCanvas: false,
        mouseTail: false,
        showWarning: false,
        triggerFocus: false,
        skipInactive: false,
        pauseAnimation: true
      });
      // Past the last event, so every event applies synchronously: the snapshot is one moment, not a playback.
      replayer.pause(replayer.getMetaData().totalTime + 1);
      const highlight = outline(replayer.iframe, anchor.current);
      setState({ phase: "shown", highlight });
    })().catch((error: unknown) => {
      if (live) {
        setState({ phase: "failed", message: error instanceof Error ? error.message : "the snapshot could not be shown" });
      }
    });
    return () => {
      live = false;
      replayer?.destroy();
    };
  }, [projectId, thread.id, thread.snapshotBlob, anchorKey]);

  const highlight = state.phase === "shown" ? state.highlight : null;
  const scaled =
    highlight === null ? null : { top: highlight.top * scale, left: highlight.left * scale, width: highlight.width * scale, height: highlight.height * scale };

  useEffect(() => {
    const shown = state.phase === "shown" ? state.highlight : null;
    latestHighlight.current?.(
      shown === null
        ? null
        : { top: shown.top * scale, left: shown.left * scale, width: shown.width * scale, height: shown.height * scale, approximate: shown.approximate }
    );
  }, [state, scale]);

  return (
    <div ref={box} className="relative w-full overflow-hidden rounded-xl border border-asst-line bg-white" style={{ height: viewport.height * scale }}>
      <div
        ref={stage}
        aria-hidden="true"
        className="feedback-replay feedback-replay-still pointer-events-none absolute left-0 top-0 origin-top-left"
        style={{ width: viewport.width, height: viewport.height, transform: `scale(${scale})` }}
      />
      {scaled === null ? null : (
        <div
          aria-hidden="true"
          data-testid="snapshot-highlight"
          className={`pointer-events-none absolute rounded-sm border-2 ${highlight?.approximate ? "border-dashed border-asst-warn" : "border-asst-accent"} bg-asst-accent/15`}
          style={{ top: scaled.top - 3, left: scaled.left - 3, width: scaled.width + 6, height: scaled.height + 6 }}
        />
      )}
      <p
        role="status"
        className={
          state.phase === "shown" && !highlight?.approximate ? "sr-only" : "absolute inset-x-0 bottom-0 bg-asst-raised px-3 py-1.5 text-xs text-asst-muted"
        }
      >
        {state.phase === "loading"
          ? "Loading the page as the reviewer saw it…"
          : state.phase === "none"
            ? "No snapshot was taken with this comment."
            : state.phase === "failed"
              ? `The snapshot could not be shown: ${state.message}.`
              : highlight?.approximate
                ? "The element could not be found in the snapshot, so the outline is where it was when the comment was made."
                : "Showing the page as the reviewer saw it, with the element outlined."}
      </p>
    </div>
  );
}

/** Scrolls the snapshot to the anchored element and answers where it is in the frame's viewport. */
function outline(iframe: HTMLIFrameElement, anchor: FeedbackAnchor): Highlight | null {
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (doc === null || win === null) {
    return null;
  }
  const element = findAnchor(doc, anchor);
  if (element !== null) {
    element.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = element.getBoundingClientRect();
    return { top: rect.top, left: rect.left, width: rect.width, height: rect.height, approximate: false };
  }
  win.scrollTo(0, Math.max(0, anchor.rect.y - anchor.viewport.height / 3));
  return { top: anchor.rect.y - win.scrollY, left: anchor.rect.x - win.scrollX, width: anchor.rect.width, height: anchor.rect.height, approximate: true };
}
