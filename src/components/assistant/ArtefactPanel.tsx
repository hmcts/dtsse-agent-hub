"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ArtefactSnapshot, SaveArtefactResult } from "@/app/_actions/assistant";
import { AssistantMarkdown } from "@/components/assistant/AssistantMarkdown";
import { useSidebarWidth } from "@/components/assistant/AssistantShell";
import { JiraBanner, type JiraExportProps, JiraFooter } from "@/components/assistant/JiraExport";
import { ARTEFACT_MIN_WIDTH, ARTEFACT_WIDTH, CHAT_MIN_WIDTH } from "@/components/assistant/layout";
import { useResizableWidth } from "@/components/assistant/useResizableWidth";
import { ScrollPane } from "@/components/Markup";
import { CopyIcon, DownloadIcon, TickIcon } from "@/components/sidebar/icons";
import type { ActionResult } from "@/web/action";

export type SaveArtefactAction = (input: {
  conversationId: unknown;
  title: unknown;
  markdown: unknown;
  baseVersion: unknown;
}) => Promise<ActionResult<SaveArtefactResult>>;

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

/**
 * Windows refuses these as the part before the first dot, whatever follows it, so `NUL.txt` is as unusable as `NUL`
 * and both download under the fallback name.
 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** Long enough for any title worth reading in a downloads list, short enough to leave room in a path. */
const NAME_LIMIT = 80;

/**
 * The download's filename: the document's title, with everything a Windows, macOS or Linux filename cannot hold
 * taken out. A title that is only punctuation, or is a name Windows reserves, falls back to `document`.
 */
export function fileName(title: string, extension: string): string {
  const cleaned = title
    // biome-ignore lint/suspicious/noControlCharactersInRegex: a filename cannot hold them, which is why they go
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, NAME_LIMIT)
    // Leading and trailing dots and spaces are stripped by Windows and hide a file on Unix, so they go here instead.
    .replace(/^[\s.]+|[\s.]+$/g, "");
  const stem = cleaned.split(".")[0] ?? "";
  return `${cleaned === "" || RESERVED_NAMES.test(stem) ? "document" : cleaned}.${extension}`;
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

export function starterDocument(productLabel: string): string {
  return `# ${productLabel}: draft\n\n## Problem\n\nDescribe the problem we're solving.\n\n## Users\n\n- \n\n## Goals\n\n1. `;
}

/**
 * The conversation's one document, beside the chat. The person edits it as markdown or reads it rendered, and it
 * saves itself after each pause. The assistant can write it too: an update from it is taken in at once unless the
 * person has unsaved changes, when they choose between the assistant's version and their own.
 */
export function ArtefactPanel({
  conversationId,
  artefact,
  productLabel,
  save,
  onClose,
  narrow,
  jira
}: {
  conversationId: string;
  artefact: ArtefactSnapshot;
  productLabel: string;
  save: SaveArtefactAction;
  onClose: () => void;
  narrow: boolean;
  /** The export to Jira, below the document; left out, the panel has none. */
  jira?: JiraExportProps;
}) {
  const [title, setTitle] = useState(artefact.title ?? "Untitled document");
  const [markdown, setMarkdown] = useState(artefact.version === 0 ? starterDocument(productLabel) : artefact.markdown);
  const [base, setBase] = useState(artefact.version);
  const [state, setState] = useState<SaveState>(artefact.version === 0 ? "draft" : "saved");
  const [mode, setMode] = useState<"edit" | "preview">(artefact.version === 0 ? "edit" : "preview");
  const [conflict, setConflict] = useState<ArtefactSnapshot | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [printing, setPrinting] = useState(false);
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
    // The page re-rendering with this panel's own save, before the save's reply has moved `base`.
    const same = artefact.markdown === markdown && (artefact.title ?? "Untitled document") === title;
    if (dirty && !same) {
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
    const result = await save({ conversationId, title: next.title, markdown: next.markdown, baseVersion: next.base });
    if (!result.ok) {
      setState("failed");
      return;
    }
    if (result.saved) {
      setBase(result.version);
      setState("saved");
      setConflict(null);
    } else {
      setState("unsaved");
      setConflict(result.current);
    }
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
      timer.current = setTimeout(() => void persist({ title: nextTitle, markdown: nextMarkdown, base }), SAVE_AFTER_MS);
    }
  }

  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
      if (noticeTimer.current !== null) {
        clearTimeout(noticeTimer.current);
      }
    },
    []
  );

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
          className="absolute -left-1 bottom-0 top-0 z-[2] w-2 cursor-col-resize hover:bg-asst-accent/25 focus:bg-asst-accent/40 focus:outline-none"
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
          className="min-w-0 flex-1 border-none bg-transparent py-1.5 text-[15px] font-medium text-asst-text outline-none"
        />
        <span role="status" className={`shrink-0 text-xs ${state === "failed" ? "text-asst-error" : state === "saved" ? "text-asst-ok" : "text-asst-faint"}`}>
          {saveLabel}
        </span>
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
      {jira === undefined ? null : <JiraBanner exported={jira.exported} />}
      {mode === "edit" ? (
        // The textarea fills the scroller and scrolls itself, so the tab stop a keyboard user needs is the box.
        <div className="min-h-0 flex-1 overflow-y-auto">
          <textarea
            ref={box}
            value={markdown}
            onChange={(event) => edited({ markdown: event.target.value })}
            aria-label="Document, in markdown"
            spellCheck
            className="block h-full min-h-full w-full resize-none border-none bg-transparent px-[22px] py-5 font-plex-mono text-[13.5px] leading-[1.7] text-asst-body outline-none"
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
      {jira === undefined ? null : (
        <JiraFooter
          conversationId={conversationId}
          exported={jira.exported}
          access={jira.access}
          exportTo={jira.exportTo}
          saved={state === "saved" && conflict === null}
          written={base > 0}
        />
      )}
      {printing ? <PrintSheet title={title} markdown={markdown} /> : null}
    </section>
  );
}
