"use client";

import { type RefObject, useEffect, useId, useRef, useState } from "react";
import type { Template } from "@/assistant/starters";
import { admitFiles, discardUpload, fileSizeLabel, pastedName, UploadAborted, uploadFile } from "@/components/assistant/uploadClient";
import { AnnouncerRegion, useAnnouncer } from "@/components/live/Announcer";

/** Above this the box scrolls rather than grows. */
const MAX_HEIGHT = 200;

type Attaching = { stage: "uploading"; sent: number } | { stage: "ready" } | { stage: "failed"; reason: string };

interface Attachment {
  /** This composer's own handle on the file, so two files of the same name stay apart. */
  key: string;
  name: string;
  mediaType: string;
  size: number;
  body: File;
  /** The hub's id, from the moment the upload is claimed, so it can be discarded while its parts are still going. */
  uploadId: string | null;
  state: Attaching;
}

function percentSent(file: Attachment): number {
  return file.state.stage === "uploading" ? Math.min(100, Math.round((file.state.sent / file.size) * 100)) : 100;
}

/**
 * The message box: Enter sends and Shift+Enter starts a new line, as in any chat. The + menu attaches files or fills
 * the box from a saved template for the person to complete. Files can also be pasted into the box or dropped on it,
 * or on `dropZone` — the message pane — so the target is large. `onFocus` lets the page warm a session up before they
 * have finished.
 *
 * Attaching needs two things, and offers nothing at all without either. `uploads` is the deployment's
 * `ASSISTANT_UPLOADS_ENABLED`, read on the server and passed down: with it off the routes answer 404, so offering an
 * Attach item would be offering something that cannot work. And a file needs a conversation to belong to — either
 * `conversationId`, or `openConversation` for the new-chat screen, where attaching is what creates one.
 */
export function Composer({
  templates,
  onSend,
  onFocus,
  disabled = false,
  initialText = "",
  uploads = false,
  conversationId,
  openConversation,
  dropZone
}: {
  templates: readonly Template[];
  /** Resolves to an error to show, or `null` once sent, which clears the box and its attachments. */
  onSend: (text: string, uploadIds: string[]) => Promise<string | null>;
  onFocus?: () => void;
  disabled?: boolean;
  initialText?: string;
  /** Whether this deployment carries files at all. Off by default, as the flag itself is. */
  uploads?: boolean;
  conversationId?: string;
  /** Answers the conversation to attach to, creating it if it does not exist yet. Called once per attached file. */
  openConversation?: () => Promise<string>;
  dropZone?: RefObject<HTMLElement | null>;
}) {
  const [text, setText] = useState(initialText);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<"closed" | "open" | "templates">("closed");
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const errorId = useId();
  const files = useAnnouncer("files");

  // The attachments are held here as well as in state: a progress event or a Remove reads the list it was started
  // from, not the one a later render closed over.
  const held = useRef<Attachment[]>([]);
  const aborts = useRef(new Map<string, AbortController>());
  const keys = useRef(0);
  const attachNow = useRef<(chosen: readonly File[]) => void>(() => undefined);

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

  const attachable = uploads && (conversationId !== undefined || openConversation !== undefined) && !disabled;

  function update(change: (current: Attachment[]) => Attachment[]): void {
    held.current = change(held.current);
    setAttachments(held.current);
  }

  function mark(key: string, state: Attaching): void {
    update((current) => current.map((file) => (file.key === key ? { ...file, state } : file)));
  }

  function claim(key: string, uploadId: string): void {
    update((current) => current.map((file) => (file.key === key ? { ...file, uploadId } : file)));
  }

  async function run(key: string): Promise<void> {
    const file = held.current.find((item) => item.key === key);
    if (file === undefined) {
      return;
    }
    const controller = new AbortController();
    aborts.current.set(key, controller);
    try {
      // On the new-chat screen there is no conversation until this call makes one, and a file cannot be sent before
      // it has one to belong to. A refusal here reaches the chip as the reason it could not be attached, with Try
      // again beside it, which is the same path as a part that failed — nothing new for the person to learn.
      const conversation = conversationId ?? (await openConversation?.());
      if (conversation === undefined || controller.signal.aborted) {
        return;
      }
      const uploadId = await uploadFile({
        conversationId: conversation,
        name: file.name,
        mediaType: file.mediaType,
        body: file.body,
        signal: controller.signal,
        onCreated: (id) => claim(key, id),
        onProgress: (sent) => mark(key, { stage: "uploading", sent })
      });
      claim(key, uploadId);
      mark(key, { stage: "ready" });
      files.announce(`${file.name} attached`);
    } catch (failure) {
      if (failure instanceof UploadAborted) {
        return;
      }
      mark(key, { stage: "failed", reason: failure instanceof Error ? failure.message : "the file could not be attached" });
      files.announce(`${file.name} could not be attached`);
    } finally {
      aborts.current.delete(key);
    }
  }

  function attach(chosen: readonly File[]): void {
    if (!attachable) {
      return;
    }
    const now = new Date();
    const named = chosen.map((file) => ({ file, name: pastedName(file.name, file.type, now), size: file.size }));
    const { accepted, refusal } = admitFiles(held.current.length, named);
    setError(refusal);
    for (const candidate of accepted) {
      keys.current += 1;
      const key = `a${keys.current}`;
      update((current) => [
        ...current,
        {
          key,
          name: candidate.name,
          size: candidate.size,
          mediaType: candidate.file.type === "" ? "application/octet-stream" : candidate.file.type,
          body: candidate.file,
          uploadId: null,
          state: { stage: "uploading", sent: 0 }
        }
      ]);
      void run(key);
    }
  }

  // The window-level drag listeners are installed once; this keeps them calling the current render's `attach`.
  useEffect(() => {
    attachNow.current = attach;
  });

  function remove(key: string): void {
    const file = held.current.find((item) => item.key === key);
    if (file === undefined) {
      return;
    }
    aborts.current.get(key)?.abort();
    aborts.current.delete(key);
    update((current) => current.filter((item) => item.key !== key));
    if (file.uploadId !== null) {
      void discardUpload(file.uploadId);
    }
    setError(null);
    files.announce(`${file.name} removed`);
  }

  function retry(key: string): void {
    const file = held.current.find((item) => item.key === key);
    if (file === undefined) {
      return;
    }
    // A part that failed part way leaves the hub counting from where it stopped, so the retry starts a new upload
    // rather than resuming the old one.
    if (file.uploadId !== null) {
      void discardUpload(file.uploadId);
    }
    update((current) => current.map((item) => (item.key === key ? { ...item, uploadId: null, state: { stage: "uploading", sent: 0 } } : item)));
    void run(key);
  }

  useEffect(() => {
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (root.current?.contains(target) === true || dropZone?.current?.contains(target) === true);
    const carriesFiles = (transfer: DataTransfer | null | undefined) =>
      transfer !== null && transfer !== undefined && (transfer.files.length > 0 || Array.from(transfer.types).includes("Files"));
    // The window-level preventDefault is what stops a file dropped just outside the target from navigating the
    // browser to it, which would lose whatever the person had typed.
    const over = (event: DragEvent) => {
      event.preventDefault();
      setDragging(inside(event.target) && carriesFiles(event.dataTransfer));
    };
    // Only when the drag left the window: moving between two elements inside it also raises `dragleave`, and is
    // followed by the `dragover` that says where it is now.
    const leave = (event: DragEvent) => {
      if (!(event.relatedTarget instanceof Node)) {
        setDragging(false);
      }
    };
    const drop = (event: DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const dropped = Array.from(event.dataTransfer?.files ?? []);
      if (dropped.length > 0 && inside(event.target)) {
        attachNow.current(dropped);
      }
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [dropZone]);

  useEffect(() => {
    const pending = aborts.current;
    return () => {
      for (const controller of pending.values()) {
        controller.abort();
      }
    };
  }, []);

  const uploading = attachments.some((file) => file.state.stage === "uploading");
  const unattached = attachments.some((file) => file.state.stage === "failed");
  const empty = text.trim() === "" && attachments.length === 0;
  const blocked = uploading
    ? "Wait for your files to finish uploading, then send."
    : unattached
      ? "One of your files could not be attached. Try again, or remove it."
      : null;
  const notice = error ?? blocked;

  async function send(): Promise<void> {
    if (empty || sending || disabled || blocked !== null) {
      return;
    }
    setSending(true);
    setError(null);
    const uploadIds = held.current.flatMap((file) => (file.uploadId === null ? [] : [file.uploadId]));
    const failure = await onSend(text, uploadIds);
    setSending(false);
    if (failure === null) {
      setText("");
      update(() => []);
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

  const chip = "flex items-center gap-2 rounded-lg border border-asst-strong bg-asst-raised px-2.5 py-1.5 text-[13px]";

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={root}
        className={`relative flex flex-col gap-2 rounded-2xl border bg-asst-field p-2.5 focus-within:border-asst-accent-line ${dragging && attachable ? "border-asst-accent" : "border-asst-line"}`}
      >
        {dragging && attachable ? <p className="text-center text-[13px] text-asst-accent-soft">Drop your files here to attach them</p> : null}
        {attachments.length === 0 ? null : (
          <ul aria-label="Attached files" className="flex flex-wrap gap-2">
            {attachments.map((file) => (
              <li key={file.key} className={chip}>
                <span aria-hidden="true" className="text-asst-accent">
                  📎
                </span>
                <span className="max-w-[200px] truncate">{file.name}</span>
                <span className="shrink-0 text-asst-faint">{fileSizeLabel(file.size)}</span>
                {file.state.stage === "uploading" ? (
                  <span
                    role="progressbar"
                    aria-label={`Uploading ${file.name}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percentSent(file)}
                    className="h-1 w-14 shrink-0 overflow-hidden rounded-full bg-asst-line"
                  >
                    <span className="block h-full rounded-full bg-asst-accent" style={{ width: `${percentSent(file)}%` }} />
                  </span>
                ) : null}
                {file.state.stage === "failed" ? (
                  <>
                    <span className="text-asst-error">{file.state.reason}</span>
                    <button type="button" onClick={() => retry(file.key)} className="shrink-0 underline hover:text-asst-text">
                      Try again
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => remove(file.key)}
                  className="shrink-0 text-base leading-none text-asst-faint hover:text-asst-text"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-2">
          <div ref={menuRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => setMenu(menu === "closed" ? "open" : "closed")}
              aria-label={attachable ? "Attach a file or add a template" : "Add a template"}
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
                {attachable ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenu("closed");
                      picker.current?.click();
                    }}
                    className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-asst-active"
                  >
                    <span aria-hidden="true" className="w-[18px] text-center text-asst-accent">
                      📎
                    </span>
                    <span className="flex-1">Attach files</span>
                  </button>
                ) : null}
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
          {attachable ? (
            <input
              ref={picker}
              type="file"
              multiple
              aria-label="Files to attach"
              className="hidden"
              onChange={(event) => {
                attach(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
          ) : null}
          <textarea
            ref={box}
            rows={1}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onFocus={onFocus}
            onPaste={(event) => {
              if (!attachable) {
                return;
              }
              const pasted = Array.from(event.clipboardData.files);
              if (pasted.length > 0) {
                event.preventDefault();
                attach(pasted);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="Message HMCTS Assistant"
            aria-label="Message"
            aria-describedby={notice === null ? undefined : errorId}
            className="max-h-[200px] min-w-0 flex-1 resize-none border-none bg-transparent py-1.5 text-[15px] leading-normal text-asst-text outline-none placeholder:text-asst-faint"
          />
          <button
            type="button"
            onClick={() => void send()}
            aria-label="Send"
            disabled={empty || sending || disabled || blocked !== null}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-asst-accent text-lg font-semibold text-asst-ink disabled:opacity-40"
          >
            ↑
          </button>
        </div>
      </div>
      {notice === null ? null : (
        <p id={errorId} role="alert" className="text-center text-[13px] text-asst-error">
          {notice}
        </p>
      )}
      <p className="text-center text-xs text-asst-faint">
        Answers can be wrong. Check against official guidance before you act on them. Do not enter personal data beyond what the task needs.
      </p>
      <AnnouncerRegion text={files.text} />
    </div>
  );
}
