"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MAX_RECORDING_MS } from "@/feedback/limits";
import {
  isWidgetMessage,
  type MarkerThread,
  type RecordedEvent,
  type ShellMessageBody,
  shellMessage,
  type WidgetAnchor,
  type WidgetMessage
} from "@/feedback/protocol";
import type { FeedbackThreadView } from "@/feedback/thread-store";
import { MentionInput } from "./MentionInput";
import { type RecordingSession, startRecordingSession } from "./recording";
import { gzipJson, type Person, putBlob, type ReviewApi, ReviewRequestFailed, reviewApi, withRetries } from "./reviewClient";
import { ThreadCard } from "./ThreadCard";

/**
 * The review page around a framed prototype: a bar with the reviewer's name, Add comment and Record, the frame, and a
 * panel of the page's comment threads. It never reloads, so the microphone runs on across the frame's page loads.
 *
 * It talks to the widget in the frame only by `postMessage`, and takes a message only from the frame's own window at
 * the viewer's origin. It is the only thing that calls the hub's feedback routes; the widget calls nothing.
 */

export interface ReviewShellProps {
  token: string;
  /** The frame's first `src`: the viewer's `/_auth?ticket=…`, which lands on the page under the link's prefix. */
  frameSrc: string;
  projectName: string;
  linkLabel: string;
  viewerName: string;
  access: "team" | "reviewer";
  maskInputs: boolean;
  retentionDays: number;
  /** For tests, which replace the hub's routes. */
  api?: ReviewApi;
}

export const POLL_MS = 15_000;
/** How long after the frame loads the widget has to say hello before the page is called unsupported. */
export const HELLO_TIMEOUT_MS = 5000;

interface Draft {
  path: string;
  anchor: WidgetAnchor;
  snapshot: RecordedEvent[];
}

interface Recording {
  session: RecordingSession;
  startedAt: number;
}

function describeAnchor(anchor: WidgetAnchor): string {
  const text = anchor.text === "" ? "" : ` “${anchor.text.length > 60 ? `${anchor.text.slice(0, 60)}…` : anchor.text}”`;
  return `${anchor.tag}${text}`;
}

function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function messageOf(error: unknown): string {
  return error instanceof ReviewRequestFailed ? error.message : "Something went wrong. Try again.";
}

export function ReviewShell(props: ReviewShellProps) {
  const { token, projectName, linkLabel, viewerName, access, maskInputs, retentionDays } = props;
  const api = useMemo(() => props.api ?? reviewApi(token), [props.api, token]);
  // The first ticket only: the page mints a fresh one each time it renders, as a refresh does, and a new `src` would
  // reload the prototype at the link's landing page, losing the reviewer's place and the page being recorded.
  const [frameSrc] = useState(props.frameSrc);
  const frameOrigin = useMemo(() => new URL(frameSrc).origin, [frameSrc]);
  const frame = useRef<HTMLIFrameElement>(null);
  const recordButton = useRef<HTMLButtonElement>(null);
  const helloSinceLoad = useRef(false);

  const [path, setPath] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [threads, setThreads] = useState<FeedbackThreadView[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftBody, setDraftBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const [missing, setMissing] = useState<readonly string[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [barHidden, setBarHidden] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consented, setConsented] = useState(false);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [recordBusy, setRecordBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const recordingRef = useRef<Recording | null>(null);
  recordingRef.current = recording;
  const stopping = useRef(false);
  const pathRef = useRef<string | null>(null);
  pathRef.current = path;

  const send = useCallback(
    (body: ShellMessageBody) => {
      frame.current?.contentWindow?.postMessage(shellMessage(body), frameOrigin);
    },
    [frameOrigin]
  );

  const refresh = useCallback(
    async (pagePath: string | null = pathRef.current) => {
      if (pagePath === null) {
        return;
      }
      try {
        const loaded = await api.threads(pagePath);
        if (pathRef.current === pagePath) {
          setThreads(loaded);
        }
      } catch (error) {
        setNotice(messageOf(error));
      }
    },
    [api]
  );

  useEffect(() => {
    api.people().then(setPeople, () => undefined);
  }, [api]);

  const numbered = useMemo(() => threads.map((thread, index) => ({ thread, number: index + 1 })), [threads]);
  const visible = useMemo(() => numbered.filter(({ thread }) => showResolved || thread.status !== "resolved"), [numbered, showResolved]);
  const openCount = threads.filter((thread) => thread.status === "open").length;

  useEffect(() => {
    if (path === null) {
      return;
    }
    const markers: MarkerThread[] = visible.map(({ thread, number }) => ({ id: thread.id, number, anchor: thread.anchor, status: thread.status }));
    send({ type: "markers", threads: markers });
  }, [visible, path, send]);

  const stopRecording = useCallback(async () => {
    const current = recordingRef.current;
    // The time limit and the button can both ask while a stop is still uploading its last segments, and a second
    // `session.stop()` would complete the recording twice.
    if (current === null || stopping.current) {
      return;
    }
    stopping.current = true;
    setRecordBusy(true);
    send({ type: "record-stop" });
    try {
      await current.session.stop();
      setAnnouncement("Recording saved");
    } catch (error) {
      setNotice(`The recording could not be finished: ${messageOf(error)}`);
    } finally {
      stopping.current = false;
      setRecording(null);
      setRecordBusy(false);
    }
  }, [send]);

  const onWidget = useCallback(
    (message: WidgetMessage) => {
      switch (message.type) {
        case "hello":
          helloSinceLoad.current = true;
          setUnavailable(false);
          pathRef.current = message.path;
          setPath(message.path);
          setMissing([]);
          setPicking(false);
          void refresh(message.path);
          if (recordingRef.current !== null) {
            send({ type: "record-start", maskInputs });
          }
          break;
        case "navigated":
          pathRef.current = message.path;
          setPath(message.path);
          setMissing([]);
          void refresh(message.path);
          break;
        case "pick-cancel":
          setPicking(false);
          break;
        case "picked":
          setPicking(false);
          setDraft({ path: message.path, anchor: message.anchor, snapshot: message.snapshot });
          setDraftBody("");
          setPanelOpen(true);
          break;
        case "marker-clicked":
          setFocused(message.id);
          setPanelOpen(true);
          break;
        case "replay-events":
          recordingRef.current?.session.addReplay(message.path, message.events);
          break;
        case "detached":
          setMissing(message.ids);
          break;
      }
    },
    [refresh, send, maskInputs]
  );

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.origin !== frameOrigin || event.source === null || event.source !== frame.current?.contentWindow || !isWidgetMessage(event.data)) {
        return;
      }
      onWidget(event.data);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [frameOrigin, onWidget]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };
    const timer = setInterval(tick, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (recording === null) {
      return;
    }
    const timer = setInterval(() => {
      const ms = Date.now() - recording.startedAt;
      setElapsed(ms);
      if (ms >= MAX_RECORDING_MS) {
        clearInterval(timer);
        void stopRecording();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [recording, stopRecording]);

  const onFrameLoad = () => {
    helloSinceLoad.current = false;
    setTimeout(() => {
      if (!helloSinceLoad.current) {
        setUnavailable(true);
        setPicking(false);
      }
    }, HELLO_TIMEOUT_MS);
  };

  const togglePicking = useCallback(() => {
    if (path === null) {
      return;
    }
    if (picking) {
      send({ type: "pick-cancel" });
      setPicking(false);
      return;
    }
    setDraft(null);
    send({ type: "pick-start" });
    setPicking(true);
    frame.current?.focus();
  }, [path, picking, send]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.code === "KeyC") {
        event.preventDefault();
        togglePicking();
      } else if (event.key === "Escape" && picking) {
        send({ type: "pick-cancel" });
        setPicking(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePicking, picking, send]);

  const saveDraft = async () => {
    const body = draftBody.trim();
    if (draft === null || body === "" || saving) {
      return;
    }
    setSaving(true);
    const current = recordingRef.current;
    try {
      const { thread, snapshotUrl } = await api.createThread({
        pagePath: draft.path,
        anchor: draft.anchor,
        body,
        snapshot: draft.snapshot.length > 0,
        ...(current === null ? {} : { recording: { id: current.session.recordingId, offsetMs: current.session.elapsed() } })
      });
      setDraft(null);
      setDraftBody("");
      setAnnouncement("Comment saved");
      setFocused(thread.id);
      if (snapshotUrl !== null) {
        const bytes = await gzipJson(draft.snapshot);
        await withRetries(() => putBlob(snapshotUrl, bytes, "application/json")).catch(() =>
          setNotice("Your comment was saved, but the picture of the page could not be.")
        );
      }
      await refresh(draft.path);
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      setSaving(false);
    }
  };

  const beginRecording = async () => {
    setConsentOpen(false);
    setConsented(true);
    setRecordBusy(true);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setNotice("Your microphone could not be used. Check the browser lets this page use it, and try again.");
      setRecordBusy(false);
      recordButton.current?.focus();
      return;
    }
    try {
      const session = await startRecordingSession({ api, stream, onUploadError: setNotice });
      setElapsed(0);
      setRecording({ session, startedAt: Date.now() });
      send({ type: "record-start", maskInputs });
      setAnnouncement("Recording started");
    } catch (error) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      setNotice(`The recording could not start: ${messageOf(error)}`);
    } finally {
      setRecordBusy(false);
      recordButton.current?.focus();
    }
  };

  const onRecord = () => {
    if (recording !== null) {
      void stopRecording();
    } else if (consented) {
      void beginRecording();
    } else {
      setConsentOpen(true);
    }
  };

  const threadActions = (thread: FeedbackThreadView) => ({
    onReply: async (body: string) => {
      try {
        await api.reply(thread.id, body);
        setAnnouncement("Reply saved");
        await refresh();
        return null;
      } catch (error) {
        return messageOf(error);
      }
    },
    onStatus: async (status: "open" | "resolved") => {
      try {
        await api.setStatus(thread.id, status);
        setAnnouncement(status === "resolved" ? "Comment resolved" : "Comment reopened");
        await refresh();
        return null;
      } catch (error) {
        return messageOf(error);
      }
    },
    onFocus: () => {
      if (focused !== thread.id) {
        setFocused(thread.id);
        send({ type: "focus-thread", id: thread.id });
      }
    }
  });

  const canComment = path !== null && !unavailable;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-asst-bg text-asst-text">
      <p aria-live="polite" role="status" className="sr-only">
        {announcement}
      </p>
      {barHidden ? (
        <button
          type="button"
          onClick={() => setBarHidden(false)}
          className="fixed right-2 top-2 z-30 rounded-full border border-asst-strong bg-asst-raised px-3 py-1 text-xs shadow-lg hover:bg-asst-field"
        >
          Show feedback bar{recording === null ? "" : ` (recording ${clock(elapsed)})`}
        </button>
      ) : (
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-asst-line bg-asst-panel px-3">
          <h1 className="min-w-0 truncate text-sm font-semibold" title={`${projectName} – ${linkLabel}`}>
            {projectName} <span className="font-normal text-asst-muted">– {linkLabel}</span>
          </h1>
          <span className="hidden text-xs text-asst-muted sm:inline">
            {viewerName}
            <span className="ml-1.5 rounded-full border border-asst-strong px-1.5 py-0.5 text-[11px]">{access === "team" ? "Team" : "Reviewer"}</span>
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={togglePicking}
              disabled={!canComment && !picking}
              aria-keyshortcuts="Alt+C"
              aria-pressed={picking}
              className={`rounded-lg px-3 py-1 text-sm font-semibold disabled:opacity-50 ${picking ? "border border-asst-strong hover:bg-asst-field" : "bg-asst-accent text-asst-ink hover:bg-asst-accent-hover"}`}
            >
              {picking ? "Cancel" : "Add comment"}
            </button>
            <button
              ref={recordButton}
              type="button"
              onClick={onRecord}
              disabled={recordBusy}
              aria-pressed={recording !== null}
              className="flex items-center gap-1.5 rounded-lg border border-asst-strong px-3 py-1 text-sm hover:bg-asst-field disabled:opacity-50"
            >
              {recording === null ? (
                "Record"
              ) : (
                <>
                  <span aria-hidden="true" className="size-2 rounded-full bg-asst-error" />
                  Stop recording <span className="tabular-nums">{clock(elapsed)}</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => setPanelOpen((open) => !open)}
              aria-expanded={panelOpen}
              aria-controls="review-comments"
              className="rounded-lg border border-asst-strong px-3 py-1 text-sm hover:bg-asst-field"
            >
              {openCount === 1 ? "1 open comment" : `${openCount} open comments`}
            </button>
            <details className="relative">
              <summary className="cursor-pointer list-none rounded-lg px-2 py-1 text-sm text-asst-muted hover:bg-asst-field">Help</summary>
              <div className="absolute right-0 top-[calc(100%+4px)] z-30 w-72 rounded-xl border border-asst-strong bg-asst-raised p-3 text-sm shadow-2xl">
                <p className="font-semibold">Keyboard shortcuts</p>
                <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
                  <dt>
                    <kbd>Alt</kbd>+<kbd>C</kbd>
                  </dt>
                  <dd>Add a comment, or cancel choosing</dd>
                  <dt>
                    <kbd>Tab</kbd>
                  </dt>
                  <dd>While choosing, move to the next element</dd>
                  <dt>
                    <kbd>Enter</kbd>
                  </dt>
                  <dd>While choosing, comment on the element</dd>
                  <dt>
                    <kbd>Esc</kbd>
                  </dt>
                  <dd>Stop choosing</dd>
                </dl>
              </div>
            </details>
            <button type="button" onClick={() => setBarHidden(true)} className="rounded-lg px-2 py-1 text-sm text-asst-muted hover:bg-asst-field">
              Hide
            </button>
          </div>
        </header>
      )}
      {notice === null ? null : (
        <div role="alert" className="flex items-center gap-2 border-b border-asst-line bg-asst-raised px-3 py-1.5 text-[13px] text-asst-warn">
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="rounded px-1.5 text-asst-muted hover:bg-asst-field">
            Dismiss
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <iframe
            ref={frame}
            title={linkLabel}
            src={frameSrc}
            onLoad={onFrameLoad}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
            className="h-full w-full border-0 bg-white"
          />
          {unavailable ? (
            <p role="status" className="absolute bottom-3 left-3 right-3 rounded-lg border border-asst-strong bg-asst-raised px-3 py-2 text-sm shadow-lg">
              Feedback is unavailable on this page. You can still use the prototype; comments work again on pages that support them.
            </p>
          ) : null}
        </div>
        {panelOpen ? (
          <aside
            id="review-comments"
            aria-label="Comments on this page"
            className="flex w-[360px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-asst-line bg-asst-panel p-3"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Comments on this page</h2>
              <label className="flex items-center gap-1.5 text-xs text-asst-muted">
                <input type="checkbox" checked={showResolved} onChange={(event) => setShowResolved(event.target.checked)} />
                Show resolved
              </label>
            </div>
            {draft === null ? null : (
              <form
                method="post"
                aria-label="New comment"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveDraft();
                }}
                className="flex flex-col gap-2 rounded-xl border border-asst-accent-line bg-asst-raised p-3"
              >
                <p className="text-xs text-asst-muted">
                  On <span className="font-semibold text-asst-text">{describeAnchor(draft.anchor)}</span>
                </p>
                <MentionInput
                  value={draftBody}
                  onChange={setDraftBody}
                  people={people}
                  label="Your comment"
                  placeholder="What do you think? Type @ to name someone."
                  autoFocus
                  disabled={saving}
                  onSubmit={() => void saveDraft()}
                />
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setDraft(null)} className="rounded-lg border border-asst-strong px-3 py-1 text-sm hover:bg-asst-field">
                    Discard
                  </button>
                  <button
                    type="submit"
                    disabled={saving || draftBody.trim() === ""}
                    className="rounded-lg bg-asst-accent px-3 py-1 text-sm font-semibold text-asst-ink hover:bg-asst-accent-hover disabled:opacity-60"
                  >
                    {saving ? "Saving…" : "Save comment"}
                  </button>
                </div>
              </form>
            )}
            {visible.length === 0 && draft === null ? (
              <p className="text-[13px] text-asst-muted">
                {canComment ? "No comments on this page yet. Choose Add comment to leave one." : "Waiting for the page…"}
              </p>
            ) : (
              <ol className="flex flex-col gap-3">
                {visible.map(({ thread, number }) => (
                  <li key={thread.id}>
                    <ThreadCard
                      thread={thread}
                      people={people}
                      number={number}
                      focused={focused === thread.id}
                      missing={missing.includes(thread.id)}
                      {...threadActions(thread)}
                    />
                  </li>
                ))}
              </ol>
            )}
          </aside>
        ) : null}
      </div>
      {consentOpen ? (
        <ConsentDialog
          retentionDays={retentionDays}
          onAccept={() => void beginRecording()}
          onCancel={() => {
            setConsentOpen(false);
            recordButton.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

function ConsentDialog({ retentionDays, onAccept, onCancel }: { retentionDays: number; onAccept: () => void; onCancel: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    first.current?.focus();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button") ?? []);
    const firstButton = focusable[0];
    const lastButton = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === firstButton) {
      event.preventDefault();
      lastButton?.focus();
    } else if (!event.shiftKey && document.activeElement === lastButton) {
      event.preventDefault();
      firstButton?.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-5">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="consent-title"
        aria-describedby="consent-body"
        onKeyDown={onKeyDown}
        className="flex w-full max-w-md flex-col gap-3 rounded-2xl border border-asst-strong bg-asst-raised p-5 shadow-2xl"
      >
        <h2 id="consent-title" className="text-base font-semibold">
          Record your review?
        </h2>
        <div id="consent-body" className="flex flex-col gap-2 text-sm text-asst-body">
          <p>Recording captures your voice through your microphone and what happens on the prototype&apos;s pages: what you click, type and scroll.</p>
          <p>Password fields are never captured.</p>
          <p>Only this project&apos;s team can listen to it.</p>
          <p>
            It is kept for {retentionDays} {retentionDays === 1 ? "day" : "days"}, then deleted.
          </p>
          <p>You can stop at any time.</p>
        </div>
        <div className="flex justify-end gap-2">
          <button ref={first} type="button" onClick={onCancel} className="rounded-lg border border-asst-strong px-3 py-1.5 text-sm hover:bg-asst-field">
            Not now
          </button>
          <button
            type="button"
            onClick={onAccept}
            className="rounded-lg bg-asst-accent px-3 py-1.5 text-sm font-semibold text-asst-ink hover:bg-asst-accent-hover"
          >
            Start recording
          </button>
        </div>
      </div>
    </div>
  );
}
