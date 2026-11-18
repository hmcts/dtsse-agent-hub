"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PreparedTemplate } from "@/assistant/docmosis-library-search";
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
import { type LoadOutcome, loadFailureSentence, loadTemplate } from "@/components/assistant/docmosisLoadClient";
import { ARTEFACT_MIN_WIDTH, CHAT_MIN_WIDTH } from "@/components/assistant/layout";
import { TemplateLibrary } from "@/components/assistant/TemplateLibrary";
import { useResizableWidth } from "@/components/assistant/useResizableWidth";
import { AnnouncerRegion, useAnnouncer } from "@/components/live/Announcer";
import { useHubSubscribe } from "@/components/live/HubStream";
import { DownloadIcon } from "@/components/sidebar/icons";

const button = "flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg border border-asst-strong px-2.5 text-[13px] hover:bg-asst-field disabled:opacity-40";

/** How long the form is left alone before what was typed is rendered. */
export const RENDER_AFTER_MS = 800;
/** How long the renderer is left alone when it is busy and says nothing of when to come back. */
const BUSY_RETRY_SECONDS = 5;

/** The latest version of the conversation's template, as the hub holds it now. */
async function readDocmosisView(conversationId: string, itemId: string, signal?: AbortSignal): Promise<DocmosisView> {
  const response = await fetch(docmosisUrl(conversationId, itemId), { cache: "no-store", ...(signal === undefined ? {} : { signal }) });
  if (!response.ok) {
    throw new Error(`the template read answered ${response.status}`);
  }
  return (await response.json()) as DocmosisView;
}

/**
 * The latest version of the template, read when the panel opens and again whenever the page says `version`,
 * `revision` or `pdf` has moved on, which is how a PDF put after the version the assistant wrote reaches the panel.
 */
export function useDocmosisView(docmosis: DocmosisSummary, conversationId: string): { view: DocmosisView | null; failed: boolean; retry: () => void } {
  const { id, version, revision, pdf } = docmosis;
  const [read, setRead] = useState<{ view: DocmosisView | null; failed: boolean }>({ view: null, failed: false });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a newer version, revision or PDF, or another attempt, is what makes the template worth reading again
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const view = await readDocmosisView(conversationId, id, controller.signal);
        setRead({ view, failed: false });
      } catch {
        if (!controller.signal.aborted) {
          setRead((before) => ({ view: before.view, failed: true }));
        }
      }
    })();
    return () => controller.abort();
  }, [conversationId, id, version, revision, pdf, attempt]);
  return { view: read.view, failed: read.failed, retry: () => setAttempt((count) => count + 1) };
}

/** The kept versions, newest first, read whenever the latest moves on. */
function useVersions(conversationId: string, itemId: string, version: number): DocmosisVersionEntry[] {
  const [versions, setVersions] = useState<DocmosisVersionEntry[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a newer version is what makes the list worth reading again
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(docmosisVersionsUrl(conversationId, itemId), { cache: "no-store", signal: controller.signal });
        if (response.ok) {
          const body = (await response.json()) as { versions: DocmosisVersionEntry[] };
          setVersions(body.versions);
        }
      } catch {
        // The picker is then the latest alone, which is the panel working without its history.
      }
    })();
    return () => controller.abort();
  }, [conversationId, itemId, version]);
  return versions;
}

/** The version a person is looking at when it is not the latest. */
function useOlderVersion(conversationId: string, itemId: string, picked: number | null): { view: DocmosisView | null; failed: boolean } {
  const [read, setRead] = useState<{ view: DocmosisView | null; failed: boolean; version: number | null }>({ view: null, failed: false, version: null });
  useEffect(() => {
    if (picked === null) {
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(docmosisVersionUrl(conversationId, itemId, picked), { cache: "no-store", signal: controller.signal });
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
  }, [conversationId, itemId, picked]);
  return picked !== null && read.version === picked ? { view: read.view, failed: read.failed } : { view: null, failed: false };
}

type PdfSource = { version: number; revision: number } | null;

/**
 * The PDF, fetched from the hub and drawn into canvases across the pane's width. The pages on screen stay until the
 * next PDF is drawn, so a re-render replaces them rather than flashing an empty pane.
 */
function PdfPane({ conversationId, itemId, source, waiting }: { conversationId: string; itemId: string; source: PdfSource; waiting: string | null }) {
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
        const response = await fetch(docmosisPdfUrl(conversationId, itemId, version), { cache: "no-store", signal: controller.signal });
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
  }, [conversationId, itemId, version, revision, attempt, paint]);

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

/**
 * A version a load from the library wrote, not yet rendered: the person's own, as first written, from a library path,
 * with no PDF and no merge error. An edit's version is rendered by the tab it was typed in, so it never counts.
 */
function awaitsFirstRender(view: DocmosisView): boolean {
  return view.by === "user" && view.revision === 0 && view.source_path !== null && !view.has_pdf && view.render_error === null;
}

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
function DocmosisTemplate({
  conversationId,
  docmosis,
  owner,
  onClose,
  narrow,
  announce,
  onBusy,
  onChange,
  onRemove,
  embedded
}: {
  conversationId: string;
  docmosis: DocmosisSummary;
  owner: boolean;
  onClose: () => void;
  narrow: boolean;
  announce: (text: string) => void;
  onBusy?: (busy: boolean) => void;
  /** Offers Change template, which swaps the form for the template library. */
  onChange?: () => void;
  /** Removes the template, answering why it could not be; left out, the panel offers no Remove. */
  onRemove?: () => Promise<string | null>;
  embedded: boolean;
}) {
  const itemId = docmosis.id;
  const latest = useDocmosisView(docmosis, conversationId);
  const versions = useVersions(conversationId, itemId, docmosis.version);
  const [picked, setPicked] = useState<number | null>(null);
  const older = useOlderVersion(conversationId, itemId, picked);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

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
  /** The loaded version whose first render has been sent, so it is sent once however often the version is adopted. */
  const firstRendered = useRef<number | null>(null);
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
    // A template the person loaded from the library arrives with no PDF, since only their own render makes one.
    if (closing.current.owner && awaitsFirstRender(arrived) && firstRendered.current !== arrived.version) {
      firstRendered.current = arrived.version;
      unrendered.current = true;
      void flush();
    }
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
      response = await fetch(docmosisRenderUrl(conversationId, itemId), {
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
        status: "rendered" | "failed" | "superseded";
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
      if (body.status === "superseded") {
        // A newer save of the person's own overtook this one, so the render of that save, queued or in flight, decides the PDF
        // and the phase; only a newer base is taken from this answer.
        const have = baseNow.current;
        if (have === null || isNewer(body, have)) {
          baseNow.current = { version: body.version, revision: body.revision };
          setBase(baseNow.current);
        }
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
    if (response.status === 502 || response.status === 503) {
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

  async function remove(): Promise<void> {
    if (onRemove === undefined) {
      return;
    }
    stopTimer();
    const problem = await onRemove().catch(() => "could not remove the template");
    if (problem !== null && mounted.current) {
      setRemoving(false);
      setRemoveError(problem);
    }
  }

  function requestChange(): void {
    // The library takes the form's place, so what is typed and not yet rendered would be lost the same way.
    if (busy && !window.confirm("Your changes are still being saved. Change the template anyway and lose them?")) {
      return;
    }
    onChange?.();
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
    <PanelShell
      title={name}
      narrow={narrow}
      embedded={embedded}
      onClose={requestClose}
      actions={
        <>
          {onChange === undefined || lookingBack ? null : (
            <button type="button" onClick={requestChange} className={button}>
              Change template
            </button>
          )}
          {onRemove === undefined ? null : (
            <button type="button" onClick={() => setRemoving(true)} className={button}>
              Remove
            </button>
          )}
        </>
      }
    >
      {removing ? <ConfirmRemove onCancel={() => setRemoving(false)} onConfirm={() => void remove()} /> : null}
      {removeError === null ? null : (
        <p role="alert" className="border-b border-asst-field px-4 py-2 text-[13px] text-asst-error">
          {removeError}
        </p>
      )}
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
          <a
            href={docmosisPdfUrl(conversationId, itemId, pdfSource.version)}
            download={`${name}-v${pdfSource.version}.pdf`}
            className={`${button} no-underline`}
          >
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
              <PdfPane conversationId={conversationId} itemId={itemId} source={pdfSource} waiting={waiting} />
            </div>
          </div>
        </div>
      )}
    </PanelShell>
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

/** The panel's frame: its width, the handle that sets it, and the header with the title and the close. */
function PanelShell({
  title,
  narrow,
  embedded,
  onClose,
  actions = null,
  children
}: {
  title: string;
  narrow: boolean;
  embedded: boolean;
  onClose: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const sidebarWidth = useSidebarWidth();
  const resize = useResizableWidth({
    storageKey: "hmcts-assistant-docmosis-width",
    label: "Resize template panel",
    initial: 860,
    min: ARTEFACT_MIN_WIDTH,
    reserve: () => CHAT_MIN_WIDTH + sidebarWidth,
    edge: "right"
  });
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
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-medium text-asst-text">{title}</h2>
        {actions}
        {embedded ? null : (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close template"
            className="h-8 w-8 shrink-0 rounded-lg text-xl leading-none text-asst-muted hover:bg-asst-field hover:text-asst-text"
          >
            ×
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

/** Asks before a template goes, which takes its versions with it. */
function ConfirmRemove({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div
      role="alertdialog"
      aria-label="Remove this template?"
      className="flex flex-wrap items-center gap-2 border-b border-asst-field bg-asst-raised px-4 py-2.5 text-[13px]"
    >
      <span className="min-w-0 flex-1">Remove this template from the chat? Its versions go with it.</span>
      <button ref={cancel} type="button" onClick={onCancel} className="rounded-lg border border-asst-strong px-3 py-1 hover:bg-asst-active">
        Cancel
      </button>
      <button type="button" onClick={onConfirm} className="rounded-lg bg-asst-accent px-3 py-1 font-semibold text-asst-ink hover:bg-asst-accent-hover">
        Remove
      </button>
    </div>
  );
}

type Load =
  | { phase: "idle" }
  | { phase: "loading" | "waking"; name: string }
  /** The load has written its version, and the page has yet to bring the summary that names it. */
  | { phase: "arriving"; name: string; item: string | undefined; version: number; revision: number }
  /** `view` is the assistant's version as read when the load was refused, or `null` when that read failed. */
  | { phase: "conflict"; template: PreparedTemplate; owner: string; item: string | null; theirs: Base; view: DocmosisView | null }
  | { phase: "failed"; message: string };

/** How long a written load waits for the page's summary before the panel reads the template itself. */
export const ARRIVAL_TIMEOUT_MS = 10_000;

const summaryOf = (id: string, view: DocmosisView): DocmosisSummary => ({
  id,
  name: view.name,
  version: view.version,
  revision: view.revision,
  updatedBy: view.by,
  pdf: view.has_pdf ? "ready" : view.render_error === null ? "pending" : "failed"
});

/** The later of the page's summary and one the panel read for itself of the same template; the page's on a tie. */
function newest(page: DocmosisSummary | null, read: DocmosisSummary | null): DocmosisSummary | null {
  if (read === null || (page !== null && page.id !== read.id)) {
    return page;
  }
  return page === null || isNewer(read, page) ? read : page;
}

const baseOf = (summary: DocmosisSummary | null): Base => ({ version: summary?.version ?? 0, revision: summary?.revision ?? 0 });

export interface TemplateLoader {
  load: Load;
  /** The library is showing in the template's place, for a load or after Change template. */
  choosing: boolean;
  /** A load is running on the pod, which cannot be called back, so nothing may leave it behind or start another. */
  pending: boolean;
  /** The template as the panel last read it, for when the page's summary has not caught up with a load. */
  adopted: DocmosisSummary | null;
  reread: number;
  choose: () => void;
  back: () => void;
  pick: (template: PreparedTemplate, library: { owner: string }) => void;
  loadAnyway: () => void;
  keepTheirs: () => void;
}

export type LoadSettled = "loaded" | "conflict" | "failed";

/** What a load from the library is aimed at: `target`, one of the `templates` of the page, or, with `null`, a new template. */

/**
 * A load from the template library and what the person decides about it. It lives with the chat rather than in the
 * panel, because the pod's job cannot be stopped: closing the panel leaves it running, and its outcome waits here for
 * the panel to open again. `onSettled` is told once the load ends, so the chat can bring the panel back.
 */
export function useTemplateLoad({
  conversationId,
  templates,
  target,
  announce,
  onSettled
}: {
  conversationId: string;
  templates: readonly DocmosisSummary[];
  target: string | null;
  announce: (text: string) => void;
  /** Told how the load ended and, when it is known, which template it wrote. */
  onSettled?: (outcome: LoadSettled, item?: string) => void;
}): TemplateLoader {
  const docmosis = templates.find((template) => template.id === target) ?? null;
  const [choosing, setChoosing] = useState(false);
  const [load, setLoad] = useState<Load>({ phase: "idle" });
  const [adopted, setAdopted] = useState<DocmosisSummary | null>(null);
  const [reread, setReread] = useState(0);
  const podJobs = useHubSubscribe("assistant_pod_job");
  const loading = useRef<AbortController | null>(null);
  const summaryNow = useRef<DocmosisSummary | null>(null);
  summaryNow.current = newest(docmosis, adopted);
  const announceNow = useRef(announce);
  announceNow.current = announce;
  const settledNow = useRef(onSettled);
  settledNow.current = onSettled;

  useEffect(() => () => loading.current?.abort(), []);

  function settle(next: Load, outcome: LoadSettled, item?: string): void {
    setLoad(next);
    settledNow.current?.(outcome, item);
  }

  function landed(name: string, item?: string): void {
    setChoosing(false);
    settle({ phase: "idle" }, "loaded", item);
    announceNow.current(`Loaded ${name}`);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: a load arriving or the summary moving on is what can end the wait
  useEffect(() => {
    if (load.phase !== "arriving") {
      return;
    }
    const written = templates.find((template) => template.id === load.item);
    if (written !== undefined && (written.version > load.version || (written.version === load.version && written.revision >= load.revision))) {
      landed(load.name, written.id);
    }
  }, [load, templates]);

  // The summary can be lost on its way to the tab, so a load that has written its version is read for itself in the end.
  const arriving = load.phase === "arriving" ? load : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the load being waited for is all that sets the timer
  useEffect(() => {
    if (arriving === null) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          if (arriving.item === undefined) {
            throw new Error("the load did not say which template it wrote");
          }
          const view = await readDocmosisView(conversationId, arriving.item, controller.signal);
          if (!controller.signal.aborted) {
            setAdopted(summaryOf(arriving.item, view));
            landed(arriving.name, arriving.item);
          }
        } catch {
          if (!controller.signal.aborted) {
            settle({ phase: "failed", message: `${arriving.name} was loaded, but it could not be shown. Reload the page to see it.` }, "failed");
          }
        }
      })();
    }, ARRIVAL_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [arriving, conversationId]);

  async function start(template: PreparedTemplate, owner: string, item: string | null, base: Base): Promise<void> {
    loading.current?.abort();
    const controller = new AbortController();
    loading.current = controller;
    setChoosing(true);
    setLoad({ phase: "loading", name: template.name });
    let outcome: LoadOutcome;
    try {
      outcome = await loadTemplate(
        conversationId,
        { ...(item === null ? {} : { item }), path: template.path, blob_sha: template.blobSha, base_version: base.version, base_revision: base.revision },
        {
          signal: controller.signal,
          events: podJobs,
          onWaking: () => setLoad({ phase: "waking", name: template.name }),
          onPending: () => setLoad({ phase: "loading", name: template.name })
        }
      );
    } catch {
      if (!controller.signal.aborted) {
        settle({ phase: "failed", message: "The template could not be loaded: the hub could not be reached. Try again." }, "failed");
      }
      return;
    }
    if (controller.signal.aborted) {
      return;
    }
    if (outcome.status === "done") {
      setLoad({ phase: "arriving", name: template.name, item: outcome.item, version: outcome.version, revision: outcome.revision });
      return;
    }
    if (outcome.status === "failed" && outcome.error === "conflict") {
      let view: DocmosisView | null = null;
      try {
        view = item === null ? null : await readDocmosisView(conversationId, item, controller.signal);
      } catch {
        // The summary's base is then the best there is; a load on it that is stale is refused as a conflict again.
      }
      if (!controller.signal.aborted) {
        const theirs = view === null ? baseOf(summaryNow.current) : { version: view.version, revision: view.revision };
        settle({ phase: "conflict", template, owner, item, theirs, view }, "conflict");
        announceNow.current("The assistant changed the template while yours was loading");
      }
      return;
    }
    if (outcome.status === "refused" && outcome.httpStatus === 409) {
      setReread((count) => count + 1);
    }
    settle({ phase: "failed", message: loadFailureSentence(outcome, { owner }) }, "failed");
  }

  const pending = load.phase === "loading" || load.phase === "waking" || load.phase === "arriving";
  return {
    load,
    choosing,
    pending,
    adopted,
    reread,
    choose: () => setChoosing(true),
    back: () => {
      if (!pending) {
        setLoad({ phase: "idle" });
        setChoosing(false);
      }
    },
    pick: (template, { owner }) => {
      if (!pending) {
        void start(template, owner, target, baseOf(summaryNow.current));
      }
    },
    loadAnyway: () => {
      if (load.phase === "conflict") {
        void start(load.template, load.owner, load.item, load.theirs);
      }
    },
    keepTheirs: () => {
      if (load.phase !== "conflict") {
        return;
      }
      if (load.view !== null && load.item !== null) {
        setAdopted(summaryOf(load.item, load.view));
      }
      setLoad({ phase: "idle" });
      setChoosing(false);
      announceNow.current("Kept the assistant's version");
    }
  };
}

/**
 * The conversation's Docmosis template beside the chat, or, for its owner, the template library to choose one from:
 * when the chat has none yet, after Change template, and for as long as a load from it is running or waits on a
 * decision. A load writes the person's own version, which reaches the panel through the page's summary like any
 * other, and the panel renders it. `loader` is the chat's, so the load outlives the panel; without one, as on a local
 * or shared chat, there is no library.
 */
export function DocmosisPanel({
  conversationId,
  docmosis,
  owner,
  onClose,
  narrow,
  announce,
  onBusy,
  onRemove,
  loader,
  embedded = false
}: {
  conversationId: string;
  /** The template to show; `null` is a new one, which the owner makes by picking from the library. */
  docmosis: DocmosisSummary | null;
  owner: boolean;
  /** Removes the template, answering why it could not be; left out, the panel offers no Remove. */
  onRemove?: () => Promise<string | null>;
  loader?: TemplateLoader;
  onClose: () => void;
  narrow: boolean;
  announce: (text: string) => void;
  onBusy?: (busy: boolean) => void;
  /** Fills the box it is placed in instead of standing beside the chat at a width the person sets. */
  embedded?: boolean;
}) {
  const summary = newest(docmosis, loader?.adopted ?? null);
  const chooser = owner && !embedded ? (loader ?? null) : null;

  if (chooser !== null && (summary === null || chooser.choosing || chooser.load.phase !== "idle")) {
    const { pending } = chooser;
    return (
      <PanelShell
        title="Choose a template"
        narrow={narrow}
        embedded={embedded}
        onClose={onClose}
        actions={
          summary === null || pending ? null : (
            <button type="button" onClick={chooser.back} className={button}>
              Back to template
            </button>
          )
        }
      >
        <LoadNotice load={chooser.load} replacing={summary?.name ?? null} onLoadAnyway={chooser.loadAnyway} onKeepTheirs={chooser.keepTheirs} />
        <TemplateLibrary onPick={chooser.pick} onCancel={summary === null || pending ? onClose : chooser.back} busy={pending} reread={chooser.reread} />
      </PanelShell>
    );
  }
  if (summary === null) {
    return (
      <PanelShell title="Template" narrow={narrow} embedded={embedded} onClose={onClose}>
        <p className="px-4 py-5 text-[13px] text-asst-muted">There is no template in this chat yet.</p>
      </PanelShell>
    );
  }
  return (
    <DocmosisTemplate
      conversationId={conversationId}
      docmosis={summary}
      owner={owner}
      onClose={onClose}
      narrow={narrow}
      announce={announce}
      onBusy={onBusy}
      embedded={embedded}
      {...(chooser === null ? {} : { onChange: chooser.choose })}
      {...(onRemove === undefined || !owner ? {} : { onRemove })}
    />
  );
}

function LoadNotice({
  load,
  replacing,
  onLoadAnyway,
  onKeepTheirs
}: {
  load: Load;
  /** The template the chat has now, which a load replaces. */
  replacing: string | null;
  onLoadAnyway: () => void;
  onKeepTheirs: () => void;
}) {
  const row = "flex shrink-0 flex-wrap items-center gap-2 border-b border-asst-field px-4 py-2.5 text-[13px]";
  const after = `${replacing === null ? "" : ` It replaces ${replacing} when it arrives.`} You can close this panel while it loads.`;
  switch (load.phase) {
    case "idle":
      return null;
    case "loading":
    case "arriving":
      return (
        <p role="status" className={`${row} text-asst-muted`}>
          {`Loading ${load.name}…${after}`}
        </p>
      );
    case "waking":
      return (
        <p role="status" className={`${row} text-asst-muted`}>
          {`Your assistant is starting, so it can load ${load.name}. This takes a minute or two.${after}`}
        </p>
      );
    case "failed":
      return (
        <p role="alert" className={`${row} text-asst-error`}>
          {load.message}
        </p>
      );
    case "conflict":
      return (
        <div role="alert" className={`${row} bg-asst-raised`}>
          <span className="min-w-0 flex-1">The assistant wrote version {load.theirs.version} while yours was loading.</span>
          <button type="button" onClick={onLoadAnyway} className={button}>
            Load mine anyway
          </button>
          <button type="button" onClick={onKeepTheirs} className={button}>
            Keep theirs
          </button>
        </div>
      );
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
