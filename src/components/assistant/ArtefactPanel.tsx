"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ArtefactSnapshot, SaveArtefactResult } from "@/app/_actions/assistant";
import { type DocumentKind, documentExports } from "@/assistant/documents";
import { fileName } from "@/assistant/downloads";
import { AssistantMarkdown } from "@/components/assistant/AssistantMarkdown";
import { useSidebarWidth } from "@/components/assistant/AssistantShell";
import { ConfluenceBanner, type ConfluenceExportProps } from "@/components/assistant/ConfluenceExport";
import { ExportFooter } from "@/components/assistant/ExportFooter";
import { GithubBanner, type GithubExportProps } from "@/components/assistant/GithubExport";
import { JiraBanner, type JiraExportProps } from "@/components/assistant/JiraExport";
import { ARTEFACT_MIN_WIDTH, ARTEFACT_WIDTH, CHAT_MIN_WIDTH } from "@/components/assistant/layout";
import { useResizableWidth } from "@/components/assistant/useResizableWidth";
import { ScrollPane } from "@/components/Markup";
import { CopyIcon, DownloadIcon, TickIcon } from "@/components/sidebar/icons";
import type { ActionResult } from "@/web/action";

export type SaveArtefactAction = (input: {
  conversationId: unknown;
  documentId: unknown;
  kind?: unknown;
  title: unknown;
  markdown: unknown;
  baseVersion: unknown;
}) => Promise<ActionResult<SaveArtefactResult>>;

/**
 * An edit the panel was closed on whose save then failed or found a newer version, handed to the page so it can open
 * the document again with the edit, and with the conflict to settle when there is one, rather than lose it.
 */
export interface UnsavedDraft {
  title: string;
  markdown: string;
  base: number;
  conflict: ArtefactSnapshot | null;
}

/** A pause in typing this long saves the document. */
const SAVE_AFTER_MS = 1000;

/** `draft`: the starting outline of a document nobody has written yet, which an update from the assistant replaces. */
type SaveState = "draft" | "saved" | "saving" | "unsaved" | "failed";

/** What the toolbar has to say about the last copy or print. A failure is on screen; success only needs announcing. */
type Notice = "copied" | "copyFailed" | "printFailed";

const NOTICES: Record<Notice, string> = {
  copied: "Document copied",
  copyFailed: "Could not copy. Select the text in the document and copy it yourself.",
  printFailed: "Could not open the print dialogue. Download the markdown instead."
};

/** How long the tick and its announcement stay after a copy. A failure stays until the next attempt. */
const COPIED_FOR_MS = 1400;

/**
 * How long to wait for `afterprint` before taking the sheet out anyway. Browsers that open a dialogue all send the
 * event; one that silently never does — a WebView, or a blocked dialogue — would otherwise leave the panel believing
 * a print is still in flight and refusing every later one.
 */
const PRINT_GIVE_UP_MS = 60_000;

/** Wraps the selection in `before` and `after`, or puts a list marker at the start of each selected line. */
export function format(
  text: string,
  start: number,
  end: number,
  kind: "bold" | "italic" | "bullets" | "numbers"
): { text: string; start: number; end: number } {
  if (kind === "bold" || kind === "italic") {
    const mark = kind === "bold" ? "**" : "*";
    return { text: `${text.slice(0, start)}${mark}${text.slice(start, end)}${mark}${text.slice(end)}`, start: start + mark.length, end: end + mark.length };
  }
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lines = text.slice(lineStart, end).split("\n");
  const marked = lines.map((line, index) => `${kind === "bullets" ? "- " : `${index + 1}. `}${line}`).join("\n");
  return { text: `${text.slice(0, lineStart)}${marked}${text.slice(end)}`, start: lineStart, end: lineStart + marked.length };
}

const SAVE_THREW = "could not save";

/** A save that threw, as a server action does when the network drops, is a save that failed. */
async function settled(saving: Promise<ActionResult<SaveArtefactResult>>): Promise<ActionResult<SaveArtefactResult>> {
  try {
    return await saving;
  } catch {
    return { ok: false, error: SAVE_THREW };
  }
}

/** The edit to give back to the page when its save, settled after the panel closed, did not land; `null` when it did. */
function unsavedDraft(edit: { title: string; markdown: string; base: number }, result: ActionResult<SaveArtefactResult>): UnsavedDraft | null {
  if (result.ok && result.saved) {
    return null;
  }
  return { ...edit, conflict: result.ok ? result.current : null };
}

/** Downloads `text` as `name`, through the one mechanism a browser gives a page: a blob URL on a clicked anchor. */
function download(text: string, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // The click has started the download by the next task; releasing the URL inside this one can cancel it.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * The toolbar's download menu, in the same shape as the hub's other menus: `aria-haspopup`, a `role="menu"` of
 * `role="menuitem"` buttons, and Escape or a click outside to dismiss. Closing from the keyboard puts focus back on
 * the trigger; a click elsewhere leaves focus where the click put it.
 */
function DownloadMenu({ onMarkdown, onPdf }: { onMarkdown: () => void; onPdf: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const close = useCallback(() => {
    if (ref.current?.contains(document.activeElement)) {
      trigger.current?.focus();
    }
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const dismiss = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !ref.current?.contains(event.target as Node)) {
        close();
      }
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, [close, open]);

  function choose(action: () => void): void {
    close();
    action();
  }

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-label="Download document"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className="flex h-[30px] w-[30px] items-center justify-center rounded-lg text-asst-muted hover:bg-asst-field hover:text-asst-text"
      >
        <DownloadIcon />
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label="Download"
          className="absolute right-0 top-[calc(100%+6px)] z-30 flex w-[230px] flex-col gap-0.5 rounded-xl border border-asst-strong bg-asst-hover p-1.5 shadow-2xl"
        >
          <button type="button" role="menuitem" onClick={() => choose(onMarkdown)} className="rounded-lg px-2.5 py-2 text-left text-sm hover:bg-asst-active">
            Markdown (.md)
          </button>
          <button type="button" role="menuitem" onClick={() => choose(onPdf)} className="rounded-lg px-2.5 py-2 text-left text-sm hover:bg-asst-active">
            PDF (opens your print dialogue)
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * What the printer is given: the document, rendered, on the body rather than inside the panel, so nothing above it
 * clips the pages and the app's theme does not colour it. `globals.css` hides it on screen.
 *
 * The cast is the portal's return type: `@types/react-dom` 18 pulls in its own `@types/react` 19, whose `ReactPortal`
 * this project's React 18 types do not recognise.
 */
function PrintSheet({ title, markdown }: { title: string; markdown: string }): React.ReactElement {
  return createPortal(
    <div className="asst-print-sheet">
      <h1>{title}</h1>
      <AssistantMarkdown source={markdown} document />
    </div>,
    document.body
  ) as React.ReactElement;
}

export function starterDocument(productLabel: string, kind: DocumentKind = "document"): string {
  if (kind === "ticket") {
    return `# ${productLabel}: story\n\nAs a \nI want \nSo that \n\n## Acceptance criteria\n\n1. `;
  }
  return `# ${productLabel}: draft\n\n## Problem\n\nDescribe the problem we're solving.\n\n## Users\n\n- \n\n## Goals\n\n1. `;
}

/** Asks before a document goes, and says that what it was exported as stays where it went. */
function ConfirmRemove({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div
      role="alertdialog"
      aria-label="Remove this document?"
      className="flex flex-wrap items-center gap-2 border-b border-asst-field bg-asst-raised px-4 py-2.5 text-[13px]"
    >
      <span className="min-w-0 flex-1">Remove this document from the chat? A ticket or page already made from it stays where it is.</span>
      <button ref={cancel} type="button" onClick={onCancel} className="rounded-lg border border-asst-strong px-3 py-1 hover:bg-asst-active">
        Cancel
      </button>
      <button type="button" onClick={onConfirm} className="rounded-lg bg-asst-accent px-3 py-1 font-semibold text-asst-ink hover:bg-asst-accent-hover">
        Remove
      </button>
    </div>
  );
}

/**
 * One of the conversation's documents, beside the chat. Its kind decides where it can be sent: a plain document to
 * the ticket tool and Confluence, a ticket to the ticket tool alone, a Confluence page to Confluence alone. The person
 * edits it as markdown or reads it rendered, and it saves itself after each pause, and as the panel closes. The assistant can write it too: an update from it is taken
 * in at once unless the person has unsaved changes, when they choose between the assistant's version and their own.
 * A save that settles after the panel has gone, and does not land, comes back to the page through `onUnsaved`.
 */
export function ArtefactPanel({
  conversationId,
  documentId,
  kind = "document",
  artefact,
  productLabel,
  save,
  onClose,
  narrow,
  jira,
  github,
  confluence,
  onBusy,
  draft,
  onDraftTaken,
  onUnsaved,
  onRemove
}: {
  conversationId: string;
  /** The document's id, made by the page for one it opened new, which the first save creates under it. */
  documentId: string;
  kind?: DocumentKind;
  artefact: ArtefactSnapshot;
  productLabel: string;
  save: SaveArtefactAction;
  onClose: () => void;
  narrow: boolean;
  /** Told whether the person has edits not yet saved, or a conflict to settle, which taking the panel away would cut short. */
  onBusy?: (busy: boolean) => void;
  /** The export to Jira, below the document; left out, the panel has none. */
  jira?: JiraExportProps;
  /** The export to GitHub, in place of the Jira one for a person whose ticket tool is GitHub. */
  github?: GithubExportProps;
  /** The publish to Confluence, beside the Jira export; left out, the panel has none. */
  confluence?: ConfluenceExportProps;
  /** An edit a closed panel could not save, to open with in place of the saved document. Read as the panel mounts. */
  draft?: UnsavedDraft;
  /** Told once the panel has taken `draft`, so the page opens the document afresh next time. */
  onDraftTaken?: () => void;
  /** Told of an edit the panel was closed on whose save failed or found a newer version, once that save settles. */
  onUnsaved?: (draft: UnsavedDraft) => void;
  /** Removes the document, answering why it could not be; left out, the panel offers no Remove. */
  onRemove?: () => Promise<string | null>;
}) {
  const offers = documentExports(kind);
  const ticketJira = offers.ticket ? jira : undefined;
  const ticketGithub = offers.ticket ? github : undefined;
  const page = offers.confluence ? confluence : undefined;
  const [title, setTitle] = useState(draft?.title ?? artefact.title ?? "Untitled document");
  const [markdown, setMarkdown] = useState(draft?.markdown ?? (artefact.version === 0 ? starterDocument(productLabel, kind) : artefact.markdown));
  const [base, setBase] = useState(draft?.base ?? artefact.version);
  const [state, setState] = useState<SaveState>(
    draft === undefined ? (artefact.version === 0 ? "draft" : "saved") : draft.conflict === null ? "failed" : "unsaved"
  );
  const [mode, setMode] = useState<"edit" | "preview">(draft !== undefined || artefact.version === 0 ? "edit" : "preview");
  const [conflict, setConflict] = useState<ArtefactSnapshot | null>(draft?.conflict ?? null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [printing, setPrinting] = useState(false);
  /** Why the last save was refused, when the hub said: a document the assistant cannot hold yet, say. */
  const [saveError, setSaveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  /** Set once the person has removed the document, so closing saves nothing back into it. */
  const removed = useRef(false);
  const sidebarWidth = useSidebarWidth();
  const resize = useResizableWidth({
    storageKey: "hmcts-assistant-artefact-width",
    label: "Resize document panel",
    initial: ARTEFACT_WIDTH,
    min: ARTEFACT_MIN_WIDTH,
    // The chat keeps its room between this panel and the sidebar, however wide the sidebar has been dragged.
    reserve: () => CHAT_MIN_WIDTH + sidebarWidth,
    edge: "right"
  });
  const box = useRef<HTMLTextAreaElement>(null);
  // A save in flight counts: an update arriving before its reply would otherwise replace what is being saved.
  const dirty = state === "unsaved" || state === "failed" || state === "saving";
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = dirty || conflict !== null;
  /**
   * The edit the panel would save as it closes: one not yet saved, or whose save failed, with no conflict in the way.
   * A conflict is the person's to settle, so closing on one saves nothing over the newer version.
   */
  const unsaved = useRef<{ title: string; markdown: string; base: number } | null>(null);
  /**
   * The version the next save is made against: the latest this panel knows of, moved by a save's reply as it lands
   * rather than a render later. A timer set while an earlier save was in flight reads it when it fires, not the
   * version there was when the person typed — which would be their own last save, and answered as a conflict.
   */
  const latestBase = useRef(base);
  latestBase.current = Math.max(latestBase.current, base);
  /** What is on screen, for a save's reply to tell whether it saved that or something typed before more was. */
  const onScreen = useRef({ title, markdown });
  onScreen.current = { title, markdown };
  /**
   * The last save queued: in flight, or waiting behind one. Each new save is chained onto it, so however many pauses
   * end while one is out they go one at a time, each against the version the one before it left.
   */
  const inFlight = useRef<Promise<void> | null>(null);
  /** The text of the last save queued, which the newer-version check and the closing save read as this panel's own. */
  const queuedText = useRef<{ title: string; markdown: string } | null>(null);
  /** Read where a closure would see a stale one: a queued save checks it before going. */
  const conflictNow = useRef(conflict);
  conflictNow.current = conflict;
  unsaved.current = (state === "unsaved" || state === "failed") && conflict === null ? { title, markdown, base } : null;
  // Read by the closing save, which runs once, so a page that hands down new functions on each render cannot set it off.
  const closing = useRef({ conversationId, documentId, kind, save, onBusy, onUnsaved });
  closing.current = { conversationId, documentId, kind, save, onBusy, onUnsaved };
  const mounted = useRef(true);

  useEffect(() => closing.current.onBusy?.(busy), [busy]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: taken once, as the panel mounts, as the draft itself is
  useEffect(() => {
    if (draft !== undefined) {
      onDraftTaken?.();
    }
  }, []);

  /**
   * Printing is what makes a PDF here: the sheet is mounted on the body, where `@media print` in `globals.css` hides
   * the app around it, and the dialogue only opens once that render has committed. `afterprint` takes the sheet back
   * out, whether the person saved the PDF or cancelled; the timer and the `catch` are so that a browser which opens
   * no dialogue cannot strand the panel with a sheet it will never take out.
   */
  useEffect(() => {
    if (!printing) {
      return;
    }
    const done = () => setPrinting(false);
    window.addEventListener("afterprint", done);
    const giveUp = setTimeout(done, PRINT_GIVE_UP_MS);
    try {
      window.print();
    } catch {
      setNotice("printFailed");
      done();
    }
    return () => {
      clearTimeout(giveUp);
      window.removeEventListener("afterprint", done);
    };
  }, [printing]);

  // The assistant, or this person in another tab, saved a newer version.
  useEffect(() => {
    if (artefact.version <= base) {
      return;
    }
    // The page re-rendering with this panel's own save, before the save's reply has moved `base`: what is on screen, or
    // what it last sent while the person typed on. Its own save is adopted as the version, and the newer text kept.
    const sameAs = (text: { title: string; markdown: string } | null) =>
      text !== null && artefact.markdown === text.markdown && (artefact.title ?? "Untitled document") === text.title;
    if (dirty && !sameAs({ title, markdown })) {
      if (sameAs(queuedText.current)) {
        latestBase.current = Math.max(latestBase.current, artefact.version);
        setBase(artefact.version);
        return;
      }
      setConflict(artefact);
      return;
    }
    setTitle(artefact.title ?? "Untitled document");
    setMarkdown(artefact.markdown);
    setBase(artefact.version);
    setState("saved");
  }, [artefact, base, dirty, markdown, title]);

  async function persist(next: { title: string; markdown: string; base: number }): Promise<void> {
    setState("saving");
    const result = await settled(save({ conversationId, documentId, kind, title: next.title, markdown: next.markdown, baseVersion: next.base }));
    // Whether or not the panel is still open: a closing save queued behind this one goes against the version it made.
    if (result.ok && result.saved) {
      latestBase.current = Math.max(latestBase.current, result.version);
    }
    // Closed while it was in flight: the page is the only one left to keep an edit that did not land.
    if (!mounted.current) {
      const lost = unsavedDraft(next, result);
      if (lost !== null) {
        closing.current.onUnsaved?.(lost);
      }
      return;
    }
    if (!result.ok) {
      setSaveError(result.error === SAVE_THREW ? null : result.error);
      setState("failed");
      return;
    }
    setSaveError(null);
    if (result.saved) {
      latestBase.current = Math.max(latestBase.current, result.version);
      setBase(result.version);
      // Saved, unless the person typed on while it was going: then the newer text is still to save, and its timer is set.
      const still = onScreen.current.markdown === next.markdown && onScreen.current.title === next.title;
      setState(still ? "saved" : "unsaved");
      setConflict(null);
    } else {
      setState("unsaved");
      // Now, not a render later: a save queued behind this one checks it as soon as this answer lands.
      conflictNow.current = result.current;
      setConflict(result.current);
    }
  }

  /**
   * Saves once every save queued before it has answered, against the version they left. A save with none ahead of it
   * goes at once. One behind a conflict is dropped: it would meet the same newer version, and the conflict is the
   * person's to settle first.
   */
  function saveInTurn(nextTitle: string, nextMarkdown: string): Promise<void> {
    const text = { title: nextTitle, markdown: nextMarkdown };
    const go = () => (conflictNow.current === null ? persist({ ...text, base: latestBase.current }) : Promise.resolve());
    const ahead = inFlight.current;
    const run = ahead === null ? go() : ahead.then(go);
    inFlight.current = run;
    queuedText.current = text;
    void run.then(() => {
      if (inFlight.current === run) {
        inFlight.current = null;
        queuedText.current = null;
      }
    });
    return run;
  }

  function edited(next: { title?: string; markdown?: string }): void {
    const nextTitle = next.title ?? title;
    const nextMarkdown = next.markdown ?? markdown;
    setTitle(nextTitle);
    setMarkdown(nextMarkdown);
    setState("unsaved");
    if (timer.current !== null) {
      clearTimeout(timer.current);
    }
    if (conflict === null) {
      timer.current = setTimeout(() => void saveInTurn(nextTitle, nextMarkdown), SAVE_AFTER_MS);
    }
  }

  // Closing, by the person or by the page opening the slides in its place, saves the edit the pause would have.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
      if (noticeTimer.current !== null) {
        clearTimeout(noticeTimer.current);
      }
      const waiting = removed.current ? null : unsaved.current;
      // A save already queued with this very text will save it, and say if it was lost; another would only race it.
      const queued = queuedText.current;
      const pending = waiting !== null && queued !== null && queued.markdown === waiting.markdown && queued.title === waiting.title ? null : waiting;
      const { conversationId: id, documentId: doc, kind: made, save: saveNow, onBusy: told } = closing.current;
      if (pending !== null) {
        // After any save still out, and against the version it leaves, rather than the one there was at the last render;
        // at once when there is none, as the page may be going.
        const send = () =>
          settled(
            saveNow({ conversationId: id, documentId: doc, kind: made, title: pending.title, markdown: pending.markdown, baseVersion: latestBase.current })
          );
        const ahead = inFlight.current;
        void (ahead === null ? send() : ahead.then(send)).then((result) => {
          const lost = unsavedDraft(pending, result);
          if (lost !== null) {
            closing.current.onUnsaved?.(lost);
          }
        });
      }
      told?.(false);
    };
  }, []);

  /** Says what happened only once it has: a tick and an announcement are the whole acknowledgement, so they must be true. */
  async function copy(): Promise<void> {
    if (noticeTimer.current !== null) {
      clearTimeout(noticeTimer.current);
      noticeTimer.current = null;
    }
    try {
      await navigator.clipboard.writeText(markdown);
    } catch {
      setNotice("copyFailed");
      return;
    }
    setNotice("copied");
    noticeTimer.current = setTimeout(() => setNotice(null), COPIED_FOR_MS);
  }

  function takeTheirs(current: ArtefactSnapshot): void {
    setTitle(current.title ?? "Untitled document");
    setMarkdown(current.markdown);
    setBase(current.version);
    setConflict(null);
    setState("saved");
  }

  function keepMine(current: ArtefactSnapshot): void {
    // The newer version is seen and overridden, so the page handing it down while this saves must not adopt it.
    setBase(current.version);
    setConflict(null);
    void persist({ title, markdown, base: current.version });
  }

  async function remove(): Promise<void> {
    if (onRemove === undefined) {
      return;
    }
    removed.current = true;
    if (timer.current !== null) {
      clearTimeout(timer.current);
    }
    const problem = await onRemove().catch(() => "could not remove the document");
    if (problem !== null && mounted.current) {
      removed.current = false;
      setRemoving(false);
      setRemoveError(problem);
    }
  }

  function applyFormat(kind: "bold" | "italic" | "bullets" | "numbers"): void {
    const element = box.current;
    if (element === null) {
      return;
    }
    const result = format(markdown, element.selectionStart, element.selectionEnd, kind);
    edited({ markdown: result.text });
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(result.start, result.end);
    });
  }

  const saveLabel = { draft: "Not saved yet", saved: "Saved", saving: "Saving…", unsaved: "Not saved yet", failed: "Could not save; keep typing to try again" }[
    state
  ];
  const tool = "h-[30px] rounded-[7px] px-2.5 text-[13px] text-asst-body hover:bg-asst-active";

  return (
    <section
      aria-label="Document"
      className={`z-[25] flex h-full shrink-0 flex-col border-l border-asst-line bg-asst-panel ${narrow ? "fixed inset-0" : "relative"}`}
      style={narrow ? undefined : { width: resize.width }}
    >
      {narrow ? null : (
        <div
          {...resize.separator}
          className="absolute -left-1 bottom-0 top-0 z-[2] w-2 cursor-col-resize hover:bg-asst-accent/25 focus:bg-asst-accent/40 focus:outline-hidden"
        />
      )}
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-asst-field pl-4 pr-3">
        <span aria-hidden="true" className="shrink-0 font-plex-mono text-[11px] uppercase tracking-wider text-asst-accent-soft">
          .md
        </span>
        <input
          value={title}
          onChange={(event) => edited({ title: event.target.value })}
          aria-label="Document title"
          maxLength={200}
          className="min-w-0 flex-1 border-none bg-transparent py-1.5 text-[15px] font-medium text-asst-text outline-hidden"
        />
        <span role="status" className={`shrink-0 text-xs ${state === "failed" ? "text-asst-error" : state === "saved" ? "text-asst-ok" : "text-asst-faint"}`}>
          {state === "failed" && saveError !== null ? `Could not save: ${saveError}` : saveLabel}
        </span>
        {onRemove === undefined ? null : (
          <button
            type="button"
            onClick={() => setRemoving(true)}
            className="h-8 shrink-0 rounded-lg px-2 text-[13px] text-asst-muted hover:bg-asst-field hover:text-asst-text"
          >
            Remove
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close document"
          className="h-8 w-8 shrink-0 rounded-lg text-xl leading-none text-asst-muted hover:bg-asst-field hover:text-asst-text"
        >
          ×
        </button>
      </div>
      <div role="toolbar" aria-label="Formatting" className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-asst-field px-3 py-1.5">
        {mode === "edit" ? (
          <>
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => applyFormat("bold")}
              aria-label="Bold"
              className={`${tool} font-bold`}
            >
              B
            </button>
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => applyFormat("italic")}
              aria-label="Italic"
              className={`${tool} italic`}
            >
              I
            </button>
            <span aria-hidden="true" className="mx-1.5 h-[18px] w-px bg-asst-strong" />
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat("bullets")} className={tool}>
              • List
            </button>
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat("numbers")} className={tool}>
              1. List
            </button>
          </>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <div className="flex rounded-[9px] bg-asst-hover p-[3px]">
            {(["edit", "preview"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={mode === option}
                onClick={() => setMode(option)}
                className={`rounded-[7px] px-2.5 py-1 text-[13px] ${mode === option ? "bg-asst-strong" : ""}`}
              >
                {option === "edit" ? "Edit" : "Preview"}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void copy()}
            aria-label="Copy document"
            className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg text-asst-muted hover:bg-asst-field hover:text-asst-text"
          >
            {/* A tick in place of the copy icon says it worked, by shape rather than by colour; the status says it aloud. */}
            {notice === "copied" ? <TickIcon /> : <CopyIcon />}
          </button>
          <DownloadMenu onMarkdown={() => download(markdown, fileName(title, "md"), "text/markdown;charset=utf-8")} onPdf={() => setPrinting(true)} />
          {/* A failure has to be read, so it is on screen; the tick already shows a copy worked. */}
          <span role="status" className={notice === null || notice === "copied" ? "sr-only" : "max-w-[220px] text-[13px] text-asst-error"}>
            {notice === null ? "" : NOTICES[notice]}
          </span>
        </div>
      </div>
      {removing ? <ConfirmRemove onCancel={() => setRemoving(false)} onConfirm={() => void remove()} /> : null}
      {removeError === null ? null : (
        <p role="alert" className="border-b border-asst-field px-4 py-2 text-[13px] text-asst-error">
          {removeError}
        </p>
      )}
      {conflict === null ? null : (
        <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-asst-field bg-asst-raised px-4 py-2.5 text-[13px]">
          <span className="min-w-0 flex-1">
            {conflict.updatedBy === "agent" ? "The assistant has changed this document." : "This document was changed somewhere else."} Use that version, or
            keep yours?
          </span>
          <button type="button" onClick={() => takeTheirs(conflict)} className="rounded-lg border border-asst-strong px-3 py-1 hover:bg-asst-active">
            Use theirs
          </button>
          <button
            type="button"
            onClick={() => keepMine(conflict)}
            className="rounded-lg bg-asst-accent px-3 py-1 font-semibold text-asst-ink hover:bg-asst-accent-hover"
          >
            Keep mine
          </button>
        </div>
      )}
      {ticketJira === undefined ? null : <JiraBanner exported={ticketJira.exported} />}
      {ticketGithub === undefined ? null : <GithubBanner exported={ticketGithub.exported} />}
      {page === undefined ? null : <ConfluenceBanner exported={page.exported} />}
      {mode === "edit" ? (
        // The textarea fills the scroller and scrolls itself, so the tab stop a keyboard user needs is the box.
        <div className="min-h-0 flex-1 overflow-y-auto">
          <textarea
            ref={box}
            value={markdown}
            onChange={(event) => edited({ markdown: event.target.value })}
            aria-label="Document, in markdown"
            spellCheck
            className="block h-full min-h-full w-full resize-none border-none bg-transparent px-[22px] py-5 font-plex-mono text-[13.5px] leading-[1.7] text-asst-body outline-hidden"
          />
        </div>
      ) : (
        // The same focusable scroller a wide table and a long code line use, because the preview holds no control of
        // its own and a keyboard user needs focus on it to scroll the rest of a long document into view. It is a
        // named region, nested in the panel's own, so the focus says what it has landed on.
        <ScrollPane as="section" label="Document preview" className="min-h-0 flex-1 overflow-y-auto px-[26px] pb-10 pt-5 text-asst-body">
          {markdown.trim() === "" ? <p className="text-asst-faint">This document is empty.</p> : <AssistantMarkdown source={markdown} document />}
        </ScrollPane>
      )}
      {ticketJira === undefined && ticketGithub === undefined && page === undefined ? null : (
        <ExportFooter
          conversationId={conversationId}
          documentId={documentId}
          jira={ticketJira}
          github={ticketGithub}
          confluence={page}
          saved={state === "saved" && conflict === null}
          written={base > 0}
        />
      )}
      {printing ? <PrintSheet title={title} markdown={markdown} /> : null}
    </section>
  );
}
