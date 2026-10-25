"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { Template } from "@/assistant/starters";
import { useDraft } from "@/components/useDraft";

/** Above this the box scrolls rather than grows. */
const MAX_HEIGHT = 200;

/**
 * The message box: Enter sends and Shift+Enter starts a new line, as in any chat. The + menu fills the box from a
 * saved template for the person to complete. `onFocus` lets the page warm a session up before they have finished.
 *
 * What is in the box is kept as a draft per `draftId`, because each conversation is its own page: going to another one
 * and back unmounts and remounts the box, and a half-written message has to outlive that. A template the person
 * picked and then left is kept the same way — it is the same "I was part-way through" — and emptying the box by hand
 * is what drops it.
 */
export function Composer({
  templates,
  onSend,
  onFocus,
  disabled = false,
  viewerOid,
  draftId
}: {
  templates: readonly Template[];
  /** Resolves to an error to show, or `null` once sent, which clears the box. */
  onSend: (text: string) => Promise<string | null>;
  onFocus?: () => void;
  disabled?: boolean;
  /** Who is reading, so the box never shows the draft of whoever signed in on this tab before them. */
  viewerOid: string;
  /** What the draft is kept under: the conversation, or the new chat that has not created one yet. */
  draftId: string;
}) {
  const { body: text, setBody: setText, discard } = useDraft({ kind: "assistant-draft", viewerOid, draftId });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<"closed" | "open" | "templates">("closed");
  const box = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const errorId = useId();

  // biome-ignore lint/correctness/useExhaustiveDependencies: the box is re-measured whenever its text changes, which it does not read
  useEffect(() => {
    const element = box.current;
    if (element) {
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
    }
  }, [text]);

  useEffect(() => {
    if (menu === "closed") {
      return;
    }
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !menuRef.current?.contains(event.target as Node)) {
        setMenu("closed");
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menu]);

  const empty = text.trim() === "";

  async function send(): Promise<void> {
    if (empty || sending || disabled) {
      return;
    }
    setSending(true);
    setError(null);
    const failure = await onSend(text);
    setSending(false);
    if (failure === null) {
      // Forgets the draft of the message that was sent, which empties the box; anything typed while the send was in
      // flight is the draft now and stays. A refused send keeps its draft, which is when it is worth the most.
      discard(text);
      box.current?.focus();
    } else {
      setError(failure);
    }
  }

  function applyTemplate(template: Template): void {
    setText(template.text);
    setMenu("closed");
    box.current?.focus();
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="relative flex items-end gap-2 rounded-2xl border border-asst-line bg-asst-field p-2.5 focus-within:border-asst-accent-line">
        <div ref={menuRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenu(menu === "closed" ? "open" : "closed")}
            aria-label="Add a template"
            aria-haspopup="menu"
            aria-expanded={menu !== "closed"}
            aria-controls={menu === "closed" ? undefined : menuId}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-asst-strong text-xl leading-none text-asst-body hover:bg-asst-bubble"
          >
            +
          </button>
          {menu !== "closed" ? (
            <div
              id={menuId}
              role="menu"
              aria-label="Add"
              className="absolute bottom-[calc(100%+10px)] left-0 z-30 flex w-[220px] flex-col gap-0.5 rounded-xl border border-asst-strong bg-asst-hover p-1.5 shadow-2xl"
            >
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={menu === "templates"}
                onClick={() => setMenu(menu === "templates" ? "open" : "templates")}
                className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-asst-active ${menu === "templates" ? "bg-asst-active" : ""}`}
              >
                <span aria-hidden="true" className="w-[18px] text-center text-asst-accent">
                  ▤
                </span>
                <span className="flex-1">Templates</span>
                <span aria-hidden="true" className="text-asst-faint">
                  ›
                </span>
              </button>
              {menu === "templates" ? (
                <div
                  role="menu"
                  aria-label="Saved templates"
                  className="absolute bottom-0 left-[calc(100%+6px)] flex w-[220px] flex-col gap-0.5 rounded-xl border border-asst-strong bg-asst-hover p-1.5 shadow-2xl max-sm:bottom-[calc(100%+6px)] max-sm:left-0"
                >
                  <p className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-asst-faint">Saved templates</p>
                  {templates.map((template) => (
                    <button
                      key={template.name}
                      type="button"
                      role="menuitem"
                      onClick={() => applyTemplate(template)}
                      className="rounded-lg px-2.5 py-2 text-left text-sm hover:bg-asst-active"
                    >
                      {template.name}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <textarea
          ref={box}
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onFocus={onFocus}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="Message HMCTS Assistant"
          aria-label="Message"
          aria-describedby={error === null ? undefined : errorId}
          className="max-h-[200px] min-w-0 flex-1 resize-none border-none bg-transparent py-1.5 text-[15px] leading-normal text-asst-text outline-none placeholder:text-asst-faint"
        />
        <button
          type="button"
          onClick={() => void send()}
          aria-label="Send"
          disabled={empty || sending || disabled}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-asst-accent text-lg font-semibold text-asst-ink disabled:opacity-40"
        >
          ↑
        </button>
      </div>
      {error === null ? null : (
        <p id={errorId} role="alert" className="text-center text-[13px] text-asst-error">
          {error}
        </p>
      )}
      <p className="text-center text-xs text-asst-faint">
        Answers can be wrong. Check against official guidance before you act on them. Do not enter personal data beyond what the task needs.
      </p>
    </div>
  );
}
