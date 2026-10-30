"use client";

import { type Ref, type RefObject, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { Skill } from "@/agents/skills";
import { type Filled, fillWith, type Template } from "@/assistant/starters";
import type { MessageAttachment } from "@/assistant/upload-store";
import { admitFiles, discardUpload, fileSizeLabel, pastedName, UploadAborted, uploadFile } from "@/components/assistant/uploadClient";
import { AnnouncerRegion, useAnnouncer } from "@/components/live/Announcer";
import { type SkillMenuTheme, useSkillMenu } from "@/components/SkillMenu";
import { useDraft } from "@/components/useDraft";

/** Above this the box scrolls rather than grows. Eight lines, which is a quarter of a phone's screen. */
const MAX_HEIGHT = 200;

/**
 * Gives the box the height its text needs, up to `MAX_HEIGHT`, and one line when it is empty.
 *
 * How tall the text is depends on how wide the box is, so a box that has not been laid out yet cannot be measured:
 * with no width, `scrollHeight` is the height of the text wrapped at nothing — a line per character — and the box
 * would be given the whole of `MAX_HEIGHT` to hold an empty message. Left at `auto` it is one line, which is what a
 * box nobody has typed in needs, until a width arrives to measure against.
 */
function fitHeight(element: HTMLTextAreaElement): void {
  element.style.height = "auto";
  if (element.clientWidth === 0) {
    return;
  }
  element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
}

/**
 * The "/" list, as a popover above the box rather than in the flow: the box here grows with what is typed, and a list
 * taking space inside it would move the line the person is on while they are still typing the skill's name. It is
 * drawn where the + menu is, so the two are never open together: opening either dismisses the other.
 */
const SKILL_MENU: SkillMenuTheme = {
  list: "absolute bottom-[calc(100%+10px)] left-0 z-30 max-h-60 w-full overflow-y-auto rounded-xl border border-asst-strong bg-asst-hover p-1.5 text-[13px] shadow-2xl",
  option: "cursor-pointer rounded-lg px-2.5 py-1.5",
  active: "bg-asst-active text-asst-text",
  idle: "text-asst-body hover:bg-asst-field",
  name: "font-plex-mono font-semibold text-asst-accent-soft",
  description: (active) => `block truncate ${active ? "text-asst-body" : "text-asst-muted"}`
};

type Attaching = { stage: "uploading"; sent: number } | { stage: "ready" } | { stage: "failed"; reason: string };

interface Attachment {
  /** This composer's own handle on the file, so two files of the same name stay apart. */
  key: string;
  name: string;
  mediaType: string;
  size: number;
  /** `null` for a chip rebuilt from the hub: the bytes are already there, so there is nothing here to send again. */
  body: File | null;
  /** The hub's id, from the moment the upload is claimed, so it can be discarded while its parts are still going. */
  uploadId: string | null;
  state: Attaching;
}

function percentSent(file: Attachment): number {
  return file.state.stage === "uploading" ? Math.min(100, Math.round((file.state.sent / file.size) * 100)) : 100;
}

/** The files the hub is already holding, as chips: finished, because the hub would not report them otherwise. */
function chipsFor(attached: readonly MessageAttachment[] = []): Attachment[] {
  return attached.map((file) => ({
    key: `h${file.id}`,
    name: file.name,
    mediaType: file.media_type,
    size: file.bytes,
    body: null,
    uploadId: file.id,
    state: { stage: "ready" }
  }));
}

/**
 * What a page holding the box may do to it. `fill` is handed what the box holds and answers what it should hold and
 * what to select, so the page decides what to put in without the box's draft having to be lifted out of it.
 */
export interface ComposerFiller {
  fill: (build: (current: string) => Filled) => void;
}

/**
 * The message box: Enter sends and Shift+Enter starts a new line, as in any chat. The + menu attaches files or fills
 * the box from a saved template for the person to complete. Files can also be pasted into the box or dropped on it,
 * or on `dropZone` — the message pane — so the target is large. `onFocus` lets the page warm a session up before they
 * have finished.
 *
 * What is in the box is kept as a draft per `draftId`, because each conversation is its own page: going to another one
 * and back unmounts and remounts the box, and a half-written message has to outlive that. A template the person
 * picked and then left is kept the same way — it is the same "I was part-way through" — and emptying the box by hand
 * is what drops it.
 *
 * Files already uploaded and not yet sent come back the same way, through `attached`, but they are read from the hub
 * rather than kept here: by the time a remount happens the bytes are in Postgres against the conversation, so the
 * hub is the only honest source for what is still waiting to be sent. A chip rebuilt that way has no `File` behind
 * it, which is why `body` is nullable — there is nothing left in the browser to retry with, and nothing that needs
 * one, because a file the hub has is already uploaded.
 *
 * A file needs a conversation to belong to, so the attach controls appear only with one in prospect: either
 * `conversationId`, or `openConversation` for the new-chat screen, where attaching is what creates one. A page whose
 * conversation cannot take a file at all says so with `attach`, and then none of the three ways in — the menu item,
 * the paste and the drop — is offered.
 *
 * Typing "/" offers the conversation's session its skills, the same list and the same keys as the hub's own box, and
 * nothing at all when the session has reported none — which is every new chat, since a skill list comes from a
 * running session and a new chat has no conversation to have one.
 */
export function Composer({
  templates,
  onSend,
  onFocus,
  disabled = false,
  viewerOid,
  draftId,
  conversationId,
  openConversation,
  attach: offerFiles = true,
  attached,
  skills = [],
  dropZone,
  filler
}: {
  templates: readonly Template[];
  /** Resolves to an error to show, or `null` once sent, which clears the box and its attachments. */
  onSend: (text: string, uploadIds: string[]) => Promise<string | null>;
  onFocus?: () => void;
  disabled?: boolean;
  /** Who is reading, so the box never shows the draft of whoever signed in on this tab before them. */
  viewerOid: string;
  /** What the draft is kept under: the conversation, or the new chat that has not created one yet. */
  draftId: string;
  conversationId?: string;
  /** Answers the conversation to attach to, creating it if it does not exist yet. Called once per attached file. */
  openConversation?: () => Promise<string>;
  /** Whether this conversation takes files at all; false hides every way of attaching one. */
  attach?: boolean;
  /** Files the hub is already holding for the next message, shown as chips again on a remount of the screen. */
  attached?: readonly MessageAttachment[];
  /** The conversation's session's skills, offered when the message starts with "/". */
  skills?: readonly Skill[];
  dropZone?: RefObject<HTMLElement | null>;
  /** Filled in with what lets the page put a template in the box, as the new-chat screen's starter cards do. */
  filler?: Ref<ComposerFiller>;
}) {
  const { body: text, setBody: setText, discard } = useDraft({ kind: "assistant-draft", viewerOid, draftId });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<"closed" | "open" | "templates">("closed");
  // Seeded once, on mount: `attached` is what the hub was holding when the page was rendered, and from then on this
  // list is the live one. A later render handing down a stale `attached` must not overwrite it.
  const [attachments, setAttachments] = useState<readonly Attachment[]>(() => chipsFor(attached));
  const [dragging, setDragging] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  // What the last fill asked to have selected, until the render that puts its text in the box has happened.
  const selecting = useRef<readonly [number, number] | null>(null);
  const [fills, setFills] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const errorId = useId();
  const files = useAnnouncer("files");
  const skillMenu = useSkillMenu({ skills, body: text, setBody: setText, field: box, theme: SKILL_MENU });

  // The attachments are held here as well as in state: a progress event or a Remove reads the list it was started
  // from, not the one a later render closed over. Starts as the same array the state did.
  const held = useRef<Attachment[]>([...attachments]);
  const aborts = useRef(new Map<string, AbortController>());
  const keys = useRef(0);
  const attachNow = useRef<(chosen: readonly File[]) => void>(() => undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the box is re-measured whenever its text changes, which it does not read
  useEffect(() => {
    const element = box.current;
    if (element) {
      fitHeight(element);
    }
  }, [text]);

  // The box is also re-measured whenever it changes width, because that is what its text wraps against. The width it
  // mounts at is not the width it keeps: the shell renders the sidebar as a column of the row until its media query
  // reports a narrow screen, so on a phone the chat beside it is first laid out too narrow to give the box any width
  // at all. A change of height is this effect's own doing, so only a change of width is acted on.
  useEffect(() => {
    const element = box.current;
    if (element === null) {
      return;
    }
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width) {
        width = element.clientWidth;
        fitHeight(element);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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

  // The "/" list is drawn in the same place as this menu, and over it, so the list opening closes the menu. Typing
  // into the box is the only way to open the list, which a pointer does by itself: it is the keyboard, tabbing from
  // the + button to the box, that can reach both.
  useEffect(() => {
    if (skillMenu.open) {
      setMenu("closed");
    }
  }, [skillMenu.open]);

  const attachable = offerFiles && (conversationId !== undefined || openConversation !== undefined) && !disabled;

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
    // A chip rebuilt from the hub has no bytes here to upload, and needs none: the hub already has the file.
    if (file === undefined || file.body === null) {
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
      // Forgets the draft of the message that was sent, which empties the box; anything typed while the send was in
      // flight is the draft now and stays. A refused send keeps both its draft and its attachments, which is when
      // they are worth the most.
      discard(text);
      update(() => []);
      box.current?.focus();
    } else {
      setError(failure);
    }
  }

  function fill(build: (current: string) => Filled): void {
    const filled = build(text);
    // Through the menu's own change, not `setText`: a template is a new message, so an earlier Escape stops holding
    // the "/" list shut.
    skillMenu.onChange(filled.text);
    selecting.current = filled.select;
    // A render even when the text is unchanged — the same card clicked twice — so the gap is selected again.
    setFills((count) => count + 1);
  }

  useImperativeHandle(filler, () => ({ fill }));

  // The selection can only be set once the box holds the new text, which is after the render that gives it it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs for each fill, which `fills` counts and it does not read
  useLayoutEffect(() => {
    const range = selecting.current;
    const element = box.current;
    if (range === null || element === null) {
      return;
    }
    selecting.current = null;
    element.focus();
    element.setSelectionRange(range[0], range[1]);
  }, [fills]);

  function applyTemplate(template: Template): void {
    // The menu replaces whatever is in the box, as it always has: picking a template from it is choosing a new message.
    fill(() => fillWith("", template.text, []));
    setMenu("closed");
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
        {skillMenu.list}
        <div className="flex items-end gap-2">
          <div ref={menuRef} className="relative flex shrink-0 items-end gap-2">
            <button
              type="button"
              onClick={() => {
                // This menu would paint over the "/" list, so opening it dismisses the list the way Escape does.
                skillMenu.dismiss();
                setMenu(menu === "closed" ? "open" : "closed");
              }}
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
            {...skillMenu.fieldProps}
            rows={1}
            value={text}
            onChange={(event) => {
              skillMenu.onChange(event.target.value);
              skillMenu.track(event);
            }}
            onSelect={skillMenu.track}
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
              if (skillMenu.onKeyDown(event)) {
                return;
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="Message CFT Workspace"
            aria-label="Message"
            aria-describedby={notice === null ? undefined : errorId}
            className="max-h-[200px] min-w-0 flex-1 resize-none border-none bg-transparent py-1.5 text-[15px] leading-normal text-asst-text outline-hidden placeholder:text-asst-faint"
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
      {/* Left off a phone: the keyboard leaves little height, and the line is the one thing here that can go. */}
      <p className="text-center text-xs text-asst-faint max-md:hidden">
        Answers can be wrong. Check against official guidance before you act on them. Do not enter personal data beyond what the task needs.
      </p>
      <AnnouncerRegion text={files.text} />
    </div>
  );
}
