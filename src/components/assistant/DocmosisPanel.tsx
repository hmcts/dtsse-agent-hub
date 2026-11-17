"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSidebarWidth } from "@/components/assistant/AssistantShell";
import { DocmosisForm, type DocmosisFormHandlers } from "@/components/assistant/DocmosisForm";
import {
  type DocmosisSummary,
  type DocmosisVersionEntry,
  type DocmosisView,
  docmosisPdfUrl,
  docmosisRenderUrl,
  docmosisUrl,
  docmosisVersionsUrl,
  docmosisVersionUrl,
  getAt,
  type JsonObject,
  pathKey,
  type RenderError,
  sameData,
  setAt,
  validateData
} from "@/components/assistant/docmosis-data";
import { drawPdf } from "@/components/assistant/docmosis-pdf";
import { ARTEFACT_MIN_WIDTH, CHAT_MIN_WIDTH } from "@/components/assistant/layout";
import { useResizableWidth } from "@/components/assistant/useResizableWidth";
import { AnnouncerRegion, useAnnouncer } from "@/components/live/Announcer";
import { DownloadIcon } from "@/components/sidebar/icons";

const button = "flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg border border-asst-strong px-2.5 text-[13px] hover:bg-asst-field disabled:opacity-40";

/** How long the form is left alone before what was typed is rendered. */
export const RENDER_AFTER_MS = 800;
/** How long the renderer is left alone when it is busy and says nothing of when to come back. */
const BUSY_RETRY_SECONDS = 5;

/**
 * The latest version of the template, read when the panel opens and again whenever the page says `version`,
 * `revision` or `pdf` has moved on, which is how a PDF put after the version the assistant wrote reaches the panel.
 */
export function useDocmosisView(docmosis: DocmosisSummary, conversationId: string): { view: DocmosisView | null; failed: boolean; retry: () => void } {
  const { version, revision, pdf } = docmosis;
  const [read, setRead] = useState<{ view: DocmosisView | null; failed: boolean }>({ view: null, failed: false });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a newer version, revision or PDF, or another attempt, is what makes the template worth reading again
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(docmosisUrl(conversationId), { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          throw new Error(`the template read answered ${response.status}`);
        }
        const view = (await response.json()) as DocmosisView;
        setRead({ view, failed: false });
      } catch {
        if (!controller.signal.aborted) {
          setRead((before) => ({ view: before.view, failed: true }));
        }
      }
    })();
    return () => controller.abort();
  }, [conversationId, version, revision, pdf, attempt]);
  return { view: read.view, failed: read.failed, retry: () => setAttempt((count) => count + 1) };
}

/** The kept versions, newest first, read whenever the latest moves on. */
function useVersions(conversationId: string, version: number): DocmosisVersionEntry[] {
  const [versions, setVersions] = useState<DocmosisVersionEntry[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a newer version is what makes the list worth reading again
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(docmosisVersionsUrl(conversationId), { cache: "no-store", signal: controller.signal });
        if (response.ok) {
          const body = (await response.json()) as { versions: DocmosisVersionEntry[] };
          setVersions(body.versions);
        }
      } catch {
        // The picker is then the latest alone, which is the panel working without its history.
      }
    })();
    return () => controller.abort();
  }, [conversationId, version]);
  return versions;
}

/** The version a person is looking at when it is not the latest. */
function useOlderVersion(conversationId: string, picked: number | null): { view: DocmosisView | null; failed: boolean } {
  const [read, setRead] = useState<{ view: DocmosisView | null; failed: boolean; version: number | null }>({ view: null, failed: false, version: null });
  useEffect(() => {
    if (picked === null) {
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(docmosisVersionUrl(conversationId, picked), { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          throw new Error(`the version read answered ${response.status}`);
        }
        setRead({ view: (await response.json()) as DocmosisView, failed: false, version: picked });
      } catch {
        if (!controller.signal.aborted) {
          setRead({ view: null, failed: true, version: picked });
        }
      }
    })();
    return () => controller.abort();
  }, [conversationId, picked]);
  return picked !== null && read.version === picked ? { view: read.view, failed: read.failed } : { view: null, failed: false };
}

type PdfSource = { version: number; revision: number } | null;

/**
 * The PDF, fetched from the hub and drawn into canvases across the pane's width. The pages on screen stay until the
 * next PDF is drawn, so a re-render replaces them rather than flashing an empty pane.
 */
function PdfPane({ conversationId, source, waiting }: { conversationId: string; source: PdfSource; waiting: string | null }) {
  const holder = useRef<HTMLDivElement>(null);
  const bytes = useRef<ArrayBuffer | null>(null);
  const drawing = useRef<AbortController | null>(null);
  const [state, setState] = useState<"empty" | "loading" | "ready" | "failed">("empty");
  const [attempt, setAttempt] = useState(0);
  const version = source?.version ?? null;
  const revision = source?.revision ?? null;

  const paint = useCallback(async (data: ArrayBuffer): Promise<void> => {
    drawing.current?.abort();
    const controller = new AbortController();
    drawing.current = controller;
    const width = Math.max(240, Math.floor(holder.current?.clientWidth ?? 0) || 600);
    const canvases = await drawPdf(data, width, controller.signal);
    if (controller.signal.aborted) {
      return;
    }
    holder.current?.replaceChildren(...canvases);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the revision is what tells an amended version's PDF from the one before it
  useEffect(() => {
    if (version === null) {
      drawing.current?.abort();
      bytes.current = null;
      holder.current?.replaceChildren();
      setState("empty");
      return;
    }
    const controller = new AbortController();
    setState("loading");
    void (async () => {
      try {
        const response = await fetch(docmosisPdfUrl(conversationId, version), { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          throw new Error(`the PDF read answered ${response.status}`);
        }
        const data = await response.arrayBuffer();
        if (controller.signal.aborted) {
          return;
        }
        bytes.current = data;
        await paint(data);
        if (!controller.signal.aborted) {
          setState("ready");
        }
      } catch {
        if (!controller.signal.aborted) {
          setState("failed");
        }
      }
    })();
    return () => controller.abort();
  }, [conversationId, version, revision, attempt, paint]);

  useEffect(() => {
    const node = holder.current;
    if (node === null || typeof ResizeObserver === "undefined") {
      return;
    }
    let width = node.clientWidth;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (Math.abs(node.clientWidth - width) < 8) {
        return;
      }
      width = node.clientWidth;
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        if (bytes.current !== null) {
          void paint(bytes.current).catch(() => undefined);
        }
      }, 200);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (timer !== null) {
        clearTimeout(timer);
      }
      drawing.current?.abort();
    };
  }, [paint]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {state === "empty" ? (
        <p role="status" className="px-4 py-5 text-[13px] text-asst-muted">
          {waiting ?? "There is no preview yet. It appears here once the template has been rendered."}
        </p>
      ) : null}
      {state === "loading" ? (
        <p role="status" className="px-4 pt-3 text-[13px] text-asst-muted">
          Loading the preview…
        </p>
      ) : null}
      {state === "failed" ? (
        <div role="alert" className="flex flex-col items-start gap-2 px-4 py-5 text-[13px] text-asst-error">
          Could not show the preview.
          <button type="button" onClick={() => setAttempt((count) => count + 1)} className={button}>
            Try again
          </button>
        </div>
      ) : null}
      <div
        ref={holder}
        aria-busy={state === "loading"}
        className="flex flex-col items-center gap-3 overflow-y-auto px-3 py-3 [&_canvas]:max-w-full [&_canvas]:bg-white [&_canvas]:shadow"
      />
    </div>
  );
}

type Phase = "idle" | "waiting" | "rendering" | "invalid" | "busy" | "failed" | "unreachable" | "rejected" | "conflict";

interface Base {
  version: number;
  revision: number;
}

const isNewer = (view: Base, base: Base): boolean => view.version > base.version || (view.version === base.version && view.revision > base.revision);

function describeVersion(entry: DocmosisVersionEntry): string {
  const who = entry.by === "agent" ? "assistant" : "you";
  return `Version ${entry.version}, by ${who}${entry.summary === null ? "" : `: ${entry.summary}`}`;
}

/**
 * The conversation's Docmosis template beside the chat, in the document panel's shell: a form generated from the
 * template's schema, and the PDF it renders, drawn on the hub's own origin.
 *
 * The owner edits. What they type is rendered 800 ms after they stop, one render at a time: edits made while one is in
 * flight are sent once it returns, and the answer to a render the person has since typed past is dropped. A reader's
 * form is read-only. `onBusy` says whether the owner has edits not yet rendered, which taking the panel away would
 * cut short.
 */
export function DocmosisPanel({
  conversationId,
  docmosis,
  owner,
  onClose,
  narrow,
  announce,
  onBusy,
  embedded = false
}: {
  conversationId: string;
  docmosis: DocmosisSummary;
  owner: boolean;
  onClose: () => void;
  narrow: boolean;
  announce: (text: string) => void;
  onBusy?: (busy: boolean) => void;
  /** Fills the box it is placed in instead of standing beside the chat at a width the person sets. */
  embedded?: boolean;
}) {
  const latest = useDocmosisView(docmosis, conversationId);
  const versions = useVersions(conversationId, docmosis.version);
  const [picked, setPicked] = useState<number | null>(null);
  const older = useOlderVersion(conversationId, picked);

  const [view, setView] = useState<DocmosisView | null>(null);
  const [data, setData] = useState<JsonObject>({});
  const [base, setBase] = useState<Base | null>(null);
  const [pdfFor, setPdfFor] = useState<PdfSource>(null);
  const [renderError, setRenderError] = useState<RenderError | null>(null);
  const [conflict, setConflict] = useState<DocmosisView | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [busyFor, setBusyFor] = useState(0);
  const [settled, setSettled] = useState(0);

  const dataNow = useRef<JsonObject>(data);
  const baseNow = useRef<Base | null>(null);
  const baseData = useRef<JsonObject>({});
  const viewNow = useRef<DocmosisView | null>(null);
  const conflictNow = useRef<DocmosisView | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const queued = useRef(false);
  /** The server holds the data but could not render it, so it is sent again whether or not the form has changed since. */
  const unrendered = useRef(false);
  const [rejection, setRejection] = useState<number | null>(null);
  const mounted = useRef(true);
  const edits = useRef(0);
  const closing = useRef({ owner });
  closing.current = { owner };
  const announceNow = useRef(announce);
  announceNow.current = announce;

  const dirty = (): boolean => !sameData(dataNow.current, baseData.current);

  function stopTimer(): void {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }

  function adopt(arrived: DocmosisView): void {
    stopTimer();
    edits.current += 1;
    viewNow.current = arrived;
    baseNow.current = { version: arrived.version, revision: arrived.revision };
    baseData.current = arrived.data;
    dataNow.current = arrived.data;
    conflictNow.current = null;
    unrendered.current = false;
    setView(arrived);
    setData(arrived.data);
    setBase(baseNow.current);
    setConflict(null);
    setRenderError(arrived.render_error);
    if (arrived.has_pdf) {
      setPdfFor({ version: arrived.version, revision: arrived.revision });
    }
    setPhase("idle");
  }

  // The assistant, or this person in another tab, wrote a newer version or revision, or the first read has arrived. A
  // newer one is taken in unless the person has typed past what they were looking at, which is theirs to settle. The
  // reply to the render in flight is waited for, since the page hears of it first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the form's state is read through refs, so only an arrival or a settled render makes this worth running
  useEffect(() => {
    const arrived = latest.view;
    if (arrived === null || inFlight.current) {
      return;
    }
    const current = baseNow.current;
    if (current === null) {
      adopt(arrived);
      return;
    }
    if (!isNewer(arrived, current)) {
      if (arrived.version === current.version && arrived.revision === current.revision) {
        if (arrived.has_pdf) {
          setPdfFor((before) =>
            before?.version === arrived.version && before.revision === arrived.revision ? before : { version: arrived.version, revision: arrived.revision }
          );
        }
        if (arrived.render_error !== null && !dirty()) {
          setRenderError(arrived.render_error);
        }
      }
      return;
    }
    if (dirty() && !sameData(arrived.data, dataNow.current)) {
      conflictNow.current = arrived;
      stopTimer();
      setConflict(arrived);
      setPhase("conflict");
      announceNow.current(arrived.by === "agent" ? "The assistant changed the template while you were editing it" : "The template was changed somewhere else");
      return;
    }
    adopt(arrived);
    announceNow.current(arrived.by === "agent" ? "The assistant updated the template" : "The template was updated");
  }, [latest.view, settled]);

  async function send(): Promise<void> {
    const from = baseNow.current;
    if (from === null) {
      return;
    }
    inFlight.current = true;
    queued.current = false;
    setPhase("rendering");
    const sent = dataNow.current;
    const sentEdits = edits.current;
    let response: Response | null = null;
    try {
      response = await fetch(docmosisRenderUrl(conversationId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ data: sent, base_version: from.version, base_revision: from.revision })
      });
    } catch {
      response = null;
    }
    inFlight.current = false;
    if (!mounted.current) {
      return;
    }
    // Typed past, so this answer is for a form the person no longer has: its version is kept as the base the next send
    // goes on, and what it drew is not shown.
    const stale = () => edits.current !== sentEdits;
    const again = () => {
      stopTimer();
      queued.current = false;
      void flush();
    };
    if (response === null) {
      setPhase("unreachable");
      setSettled((count) => count + 1);
      return;
    }
    if (response.status === 200) {
      const body = (await response.json().catch(() => null)) as {
        version: number;
        revision: number;
        status: "rendered" | "failed";
        error?: RenderError;
      } | null;
      if (!mounted.current) {
        return;
      }
      if (body === null) {
        setPhase("unreachable");
        setSettled((count) => count + 1);
        return;
      }
      unrendered.current = false;
      baseNow.current = { version: body.version, revision: body.revision };
      baseData.current = sent;
      setBase(baseNow.current);
      setSettled((count) => count + 1);
      if (stale()) {
        again();
        return;
      }
      if (body.status === "rendered") {
        setPdfFor({ version: body.version, revision: body.revision });
        setRenderError(null);
        setPhase("idle");
      } else {
        setRenderError(body.error ?? { short: "The template could not be rendered.", long: "" });
        setPhase("failed");
        announceNow.current("The template could not be rendered");
      }
      return;
    }
    if (response.status === 409) {
      const body = (await response.json().catch(() => null)) as { current?: DocmosisView } | null;
      if (!mounted.current) {
        return;
      }
      const current = body?.current;
      if (current === undefined) {
        setPhase("unreachable");
        return;
      }
      if (sameData(current.data, dataNow.current)) {
        adopt(current);
      } else if (!dirty()) {
        adopt(current);
      } else {
        conflictNow.current = current;
        setConflict(current);
        setPhase("conflict");
        announceNow.current(
          current.by === "agent" ? "The assistant changed the template while you were editing it" : "The template was changed somewhere else"
        );
      }
      setSettled((count) => count + 1);
      return;
    }
    if (response.status === 429 || response.status === 502 || response.status === 503) {
      const body = (await response.json().catch(() => null)) as { retry_after?: number; version?: number; revision?: number } | null;
      if (!mounted.current) {
        return;
      }
      // The data is kept on the server whether or not it could be rendered, so the next send goes on from there.
      if (typeof body?.version === "number" && typeof body.revision === "number") {
        baseNow.current = { version: body.version, revision: body.revision };
        baseData.current = sent;
        setBase(baseNow.current);
      }
      unrendered.current = true;
      if (response.status === 502) {
        setPhase("unreachable");
        setSettled((count) => count + 1);
        return;
      }
      const header = Number(response.headers.get("retry-after"));
      const asked = Number.isFinite(header) && header > 0 ? header : typeof body?.retry_after === "number" && body.retry_after > 0 ? body.retry_after : 0;
      const seconds = asked > 0 ? asked : BUSY_RETRY_SECONDS;
      setPhase("busy");
      setBusyFor(seconds);
      stopTimer();
      timer.current = setTimeout(() => {
        timer.current = null;
        void flush();
      }, seconds * 1000);
      setSettled((count) => count + 1);
      return;
    }
    if (response.status >= 400 && response.status < 500) {
      setRejection(response.status);
      setPhase("rejected");
    } else {
      setPhase("unreachable");
    }
    setSettled((count) => count + 1);
  }

  async function flush(): Promise<void> {
    timer.current = null;
    const shown = viewNow.current;
    if (!closing.current.owner || shown === null || conflictNow.current !== null) {
      return;
    }
    if (!dirty() && !unrendered.current) {
      setPhase("idle");
      return;
    }
    if (validateData(shown.schema.root, dataNow.current).length > 0) {
      setPhase("invalid");
      return;
    }
    if (inFlight.current) {
      queued.current = true;
      return;
    }
    await send();
  }

  function edited(next: JsonObject): void {
    dataNow.current = next;
    edits.current += 1;
    setData(next);
    if (conflictNow.current !== null) {
      return;
    }
    setPhase((before) => (before === "rendering" ? before : "waiting"));
    stopTimer();
    timer.current = setTimeout(() => void flush(), RENDER_AFTER_MS);
  }

  function keepMine(theirs: DocmosisView): void {
    viewNow.current = theirs;
    baseNow.current = { version: theirs.version, revision: theirs.revision };
    baseData.current = theirs.data;
    conflictNow.current = null;
    edits.current += 1;
    setView(theirs);
    setBase(baseNow.current);
    setConflict(null);
    setPhase("waiting");
    announceNow.current("Keeping your changes");
    stopTimer();
    void flush();
  }

  function takeTheirs(theirs: DocmosisView): void {
    adopt(theirs);
    announceNow.current("Using the newer version");
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, when the panel comes and goes
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopTimer();
      onBusyNow.current?.(false);
    };
  }, []);

  const onBusyNow = useRef(onBusy);
  onBusyNow.current = onBusy;
  const busy =
    owner &&
    (phase === "waiting" ||
      phase === "rendering" ||
      phase === "invalid" ||
      phase === "busy" ||
      phase === "unreachable" ||
      phase === "rejected" ||
      phase === "conflict");

  function requestClose(): void {
    // What is typed is sent only while the panel is open, so closing on it would lose it.
    if (busy && !window.confirm("Your changes are still being saved. Close anyway and lose them?")) {
      return;
    }
    onClose();
  }

  useEffect(() => {
    onBusyNow.current?.(busy);
  }, [busy]);

  const lookingBack = picked !== null && base !== null && picked !== base.version;
  const shownView = lookingBack ? older.view : view;
  const shownData = lookingBack ? (older.view?.data ?? {}) : data;
  const readOnly = !owner || lookingBack;
  const issues = useMemo(() => {
    const found = new Map<string, string>();
    if (shownView !== null) {
      for (const issue of validateData(shownView.schema.root, shownData)) {
        found.set(pathKey(issue.path), issue.message);
      }
    }
    return found;
  }, [shownView, shownData]);

  const handlers: DocmosisFormHandlers = {
    set: (path, value) => edited(setAt(dataNow.current, path, value)),
    addRow: (path) => {
      const rows = getAt(dataNow.current, path);
      edited(setAt(dataNow.current, [...path, Array.isArray(rows) ? rows.length : 0], {}));
    },
    removeRow: (path, index) => {
      const rows = getAt(dataNow.current, path);
      edited(setAt(dataNow.current, path, Array.isArray(rows) ? rows.filter((_row, at) => at !== index) : []));
    }
  };

  const pdfSource: PdfSource = lookingBack ? (older.view?.has_pdf === true ? { version: older.view.version, revision: older.view.revision } : null) : pdfFor;
  const shownError = lookingBack ? (older.view?.render_error ?? null) : renderError;
  const name = shownView?.name ?? docmosis.name;
  const sidebarWidth = useSidebarWidth();
  const resize = useResizableWidth({
    storageKey: "hmcts-assistant-docmosis-width",
    label: "Resize template panel",
    initial: 860,
    min: ARTEFACT_MIN_WIDTH,
    reserve: () => CHAT_MIN_WIDTH + sidebarWidth,
    edge: "right"
  });

  function downloadData(): void {
    const text = `${JSON.stringify(shownData, null, 2)}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}-v${shownView?.version ?? docmosis.version}-data.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const status = statusLine(phase, busyFor, lookingBack, owner);
  const waiting =
    !lookingBack && view !== null && view.by === "agent" && !view.has_pdf && view.render_error === null && pdfFor === null
      ? "Waiting for the assistant's PDF…"
      : null;

  return (
    <section
      aria-label="Template"
      className={
        embedded
          ? "flex h-full min-h-0 w-full flex-col bg-asst-panel"
          : `z-[25] flex h-full shrink-0 flex-col border-l border-asst-line bg-asst-panel ${narrow ? "fixed inset-0" : "relative"}`
      }
      style={narrow || embedded ? undefined : { width: resize.width }}
    >
      {narrow || embedded ? null : (
        <div
          {...resize.separator}
          className="absolute -left-1 bottom-0 top-0 z-[2] w-2 cursor-col-resize hover:bg-asst-accent/25 focus:bg-asst-accent/40 focus:outline-hidden"
        />
      )}
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-asst-field pl-4 pr-3">
        <span aria-hidden="true" className="shrink-0 font-plex-mono text-[11px] uppercase tracking-wider text-asst-accent-soft">
          .docx
        </span>
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-medium text-asst-text">{name}</h2>
        {embedded ? null : (
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close template"
            className="h-8 w-8 shrink-0 rounded-lg text-xl leading-none text-asst-muted hover:bg-asst-field hover:text-asst-text"
          >
            ×
          </button>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-asst-field px-4 py-2">
        <label htmlFor="template-version" className="sr-only">
          Version
        </label>
        <select
          id="template-version"
          value={lookingBack ? picked : (base?.version ?? docmosis.version)}
          onChange={(event) => {
            const next = Number(event.target.value);
            setPicked(base !== null && next === base.version ? null : next);
          }}
          className="h-[30px] min-w-0 max-w-full shrink rounded-lg border border-asst-strong bg-asst-field px-2 text-[13px] text-asst-text"
        >
          {(versions.length === 0 ? [{ version: docmosis.version, by: docmosis.updatedBy, summary: null, updated_at: "", has_pdf: false }] : versions).map(
            (entry) => (
              <option key={entry.version} value={entry.version}>
                {describeVersion(entry)}
              </option>
            )
          )}
        </select>
        <span role="status" className="min-w-0 flex-1 truncate text-[13px] text-asst-muted">
          {status}
        </span>
        {pdfSource === null ? null : (
          <a href={docmosisPdfUrl(conversationId, pdfSource.version)} download={`${name}-v${pdfSource.version}.pdf`} className={`${button} no-underline`}>
            <DownloadIcon />
            Download PDF
          </a>
        )}
        <button type="button" onClick={downloadData} disabled={shownView === null} className={button}>
          <DownloadIcon />
          Download data.json
        </button>
      </div>
      {lookingBack ? (
        <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-asst-field bg-asst-raised px-4 py-2.5 text-[13px]">
          <span className="min-w-0 flex-1">
            {older.failed ? `Couldn't load version ${picked}.` : `Version ${picked} is not the latest, so it can't be edited.`}
          </span>
          <button type="button" onClick={() => setPicked(null)} className={button}>
            Back to the latest
          </button>
        </div>
      ) : null}
      {conflict === null ? null : (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-asst-field bg-asst-raised px-4 py-2.5 text-[13px]">
          <span className="min-w-0 flex-1">
            {conflict.by === "agent" ? "The assistant has changed this template." : "This template was changed somewhere else."} Use that version, or keep what
            you have typed.
          </span>
          <button type="button" onClick={() => takeTheirs(conflict)} className={button}>
            Use the newer version
          </button>
          <button type="button" onClick={() => keepMine(conflict)} className={button}>
            Keep my changes
          </button>
        </div>
      )}
      {phase === "unreachable" && owner ? (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-asst-field px-4 py-2.5 text-[13px] text-asst-error">
          <span className="min-w-0 flex-1">The renderer could not be reached.</span>
          <button type="button" onClick={() => void flush()} className={button}>
            Try again
          </button>
        </div>
      ) : null}
      {phase === "rejected" && owner ? (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-asst-field px-4 py-2.5 text-[13px] text-asst-error">
          <span className="min-w-0 flex-1">{`The renderer turned the request down (status ${rejection}), so retrying will not help. Check the values and change one.`}</span>
        </div>
      ) : null}
      {latest.view === null && view === null ? (
        latest.failed ? (
          <div role="alert" className="flex flex-col items-start gap-2 px-4 py-5 text-[13px] text-asst-error">
            Could not load the template.
            <button type="button" onClick={latest.retry} className={button}>
              Try again
            </button>
          </div>
        ) : (
          <p role="status" className="px-4 py-5 text-[13px] text-asst-muted">
            Loading the template…
          </p>
        )
      ) : (
        <div className="@container flex min-h-0 flex-1">
          <div className="flex min-h-0 flex-1 flex-col @[640px]:flex-row">
            <div className="min-h-0 flex-1 overflow-y-auto border-b border-asst-field px-4 py-3 @[640px]:max-w-[45%] @[640px]:border-b-0 @[640px]:border-r">
              {shownView === null ? (
                <p role="status" className="text-[13px] text-asst-muted">
                  Loading version {picked}…
                </p>
              ) : (
                <>
                  {shownView.schema.warnings.length === 0 ? null : (
                    <ul className="mb-3 list-disc pl-5 text-[12px] text-asst-muted">
                      {shownView.schema.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  )}
                  <DocmosisForm schema={shownView.schema.root} data={shownData} issues={issues} readOnly={readOnly} handlers={handlers} />
                </>
              )}
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              {shownError === null ? null : (
                <div role="alert" className="shrink-0 border-b border-asst-field px-4 py-2.5 text-[13px] text-asst-error">
                  <p>{shownError.short}</p>
                  {shownError.long === "" ? null : (
                    <details className="mt-1 text-asst-body">
                      <summary className="cursor-pointer">Details</summary>
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[12px]">{shownError.long}</pre>
                    </details>
                  )}
                </div>
              )}
              <PdfPane conversationId={conversationId} source={pdfSource} waiting={waiting} />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function statusLine(phase: Phase, busyFor: number, lookingBack: boolean, owner: boolean): string {
  if (lookingBack) {
    return "";
  }
  switch (phase) {
    case "waiting":
      return "Changes not yet rendered";
    case "rendering":
      return "Rendering…";
    case "invalid":
      return "Fix the highlighted dates to render";
    case "busy":
      return `The renderer is busy, trying again in ${busyFor}s`;
    case "failed":
      return "Could not render";
    case "unreachable":
    case "rejected":
    case "conflict":
      return "";
    default:
      return owner ? "Up to date" : "";
  }
}

/** The template on a shared chat's page, read-only, in a box of its own where the shared deck would be. */
export function SharedDocmosis({ conversationId, docmosis }: { conversationId: string; docmosis: DocmosisSummary }) {
  const template = useAnnouncer("template");
  return (
    <div className="h-[min(640px,80vh)] overflow-hidden rounded-2xl border border-asst-line">
      <DocmosisPanel
        conversationId={conversationId}
        docmosis={docmosis}
        owner={false}
        narrow={false}
        announce={template.announce}
        onClose={() => undefined}
        embedded
      />
      <AnnouncerRegion text={template.text} />
    </div>
  );
}
