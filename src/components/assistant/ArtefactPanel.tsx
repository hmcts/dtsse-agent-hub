"use client";

import { useEffect, useRef, useState } from "react";
import type { ArtefactSnapshot, SaveArtefactResult } from "@/app/_actions/assistant";
import { AssistantMarkdown } from "@/components/assistant/AssistantMarkdown";
import { useSidebarWidth } from "@/components/assistant/AssistantShell";
import { ARTEFACT_MIN_WIDTH, ARTEFACT_WIDTH, CHAT_MIN_WIDTH } from "@/components/assistant/layout";
import { useResizableWidth } from "@/components/assistant/useResizableWidth";
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
  narrow
}: {
  conversationId: string;
  artefact: ArtefactSnapshot;
  productLabel: string;
  save: SaveArtefactAction;
  onClose: () => void;
  narrow: boolean;
}) {
  const [title, setTitle] = useState(artefact.title ?? "Untitled document");
  const [markdown, setMarkdown] = useState(artefact.version === 0 ? starterDocument(productLabel) : artefact.markdown);
  const [base, setBase] = useState(artefact.version);
  const [state, setState] = useState<SaveState>(artefact.version === 0 ? "draft" : "saved");
  const [mode, setMode] = useState<"edit" | "preview">(artefact.version === 0 ? "edit" : "preview");
  const [conflict, setConflict] = useState<ArtefactSnapshot | null>(null);
  const [copied, setCopied] = useState(false);
  const sidebarWidth = useSidebarWidth();
  const resize = useResizableWidth({
    storageKey: "hmcts-assistant-artefact-width",
    label: "Resize document panel",
    initial: ARTEFACT_WIDTH,
    min: ARTEFACT_MIN_WIDTH,
    // The chat keeps its room between this panel and the sidebar, however wide the sidebar has been dragged.
    reserve: CHAT_MIN_WIDTH + sidebarWidth,
    edge: "right",
    active: !narrow
  });
  const box = useRef<HTMLTextAreaElement>(null);
  // A save in flight counts: an update arriving before its reply would otherwise replace what is being saved.
  const dirty = state === "unsaved" || state === "failed" || state === "saving";
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    },
    []
  );

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
            onClick={() => {
              void navigator.clipboard?.writeText(markdown);
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }}
            className="h-[30px] rounded-lg px-2.5 text-[13px] text-asst-muted hover:bg-asst-field"
          >
            {copied ? "Copied" : "Copy"}
          </button>
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        {mode === "edit" ? (
          <textarea
            ref={box}
            value={markdown}
            onChange={(event) => edited({ markdown: event.target.value })}
            aria-label="Document, in markdown"
            spellCheck
            className="block h-full min-h-full w-full resize-none border-none bg-transparent px-[22px] py-5 font-plex-mono text-[13.5px] leading-[1.7] text-asst-body outline-none"
          />
        ) : (
          <div className="px-[26px] pb-10 pt-5 text-asst-body">
            {markdown.trim() === "" ? <p className="text-asst-faint">This document is empty.</p> : <AssistantMarkdown source={markdown} document />}
          </div>
        )}
      </div>
    </section>
  );
}
