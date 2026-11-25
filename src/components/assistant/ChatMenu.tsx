"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { FOLDER_NAME_MAX } from "@/assistant/folders";
import { useDismiss } from "@/components/assistant/useDismiss";
import { moveFocusInMenu } from "@/components/assistant/useMenuButton";
import { actionThrew } from "@/web/action-fault";

const TRIGGER = "flex h-[34px] w-[34px] items-center justify-center rounded-[9px] text-lg text-asst-muted hover:bg-asst-field hover:text-asst-text";

/**
 * A generous allowance for the panel's height, used to decide which way it opens before it is rendered and can be
 * measured. Its tallest pane, Move to folder with its folders scrolling at their most and Remove from folder below,
 * comes to about 330px.
 */
const PANEL_HEIGHT = 360;

/** How wide the panel is wherever there is room for it; the sidebar can be dragged narrower than this. */
const PANEL_WIDTH = 240;

/** Kept between the panel's left edge and whatever would clip it, so it never sits flush against the sidebar. */
const PANEL_INSET = 4;

/** What an action that rejects gets instead of its own refusal, having never reached the server to be refused. */
export const UNREACHABLE = (what: string) => `The ${what} could not be sent. Check your connection and try again.`;

/**
 * The room around `element` before the nearest edge that would clip the panel: whichever is closer, the window or a
 * scrolling ancestor. Both matter in the sidebar, whose list of chats scrolls, ends well above the bottom of the
 * window, and can be dragged narrower than the panel's own width.
 *
 * `beside` is measured to the left, because the panel hangs from the element's right edge.
 */
function room(element: HTMLElement): { above: number; below: number; beside: number } {
  const rect = element.getBoundingClientRect();
  let top = 0;
  let bottom = window.innerHeight;
  let left = 0;
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "hidden") {
      const box = node.getBoundingClientRect();
      top = Math.max(top, box.top);
      bottom = Math.min(bottom, box.bottom);
      left = Math.max(left, box.left);
    }
  }
  return { above: rect.top - top, below: bottom - rect.bottom, beside: rect.right - left - PANEL_INSET };
}

/** Which way a sidebar row's panel opens and how wide it is, from the room around its trigger. */
export function panelPlacement(trigger: HTMLElement | null): { above: boolean; width: number } {
  const space = trigger === null ? null : room(trigger);
  // An environment without layout, such as jsdom, measures zeros, so the panel opens downward at its full width,
  // as it does wherever there is room for it.
  return {
    above: space !== null && space.below < PANEL_HEIGHT && space.above >= PANEL_HEIGHT,
    width: space === null || space.beside <= 0 ? PANEL_WIDTH : Math.min(PANEL_WIDTH, space.beside)
  };
}

/** A folder the chat can be moved into, as the Move to folder pane lists it. */
export interface MoveTarget {
  id: string;
  name: string;
}

/** What the rename box and the delete question say of each kind of item. */
const NOUNS = {
  chat: { field: "Chat name", ask: "Delete this chat and its document? This cannot be undone.", max: 200 },
  form: { field: "Form name", ask: "Delete this form and all its versions? This cannot be undone.", max: 200 },
  folder: { field: "Folder name", ask: "Delete this folder? The chats in it are kept.", max: FOLDER_NAME_MAX }
} as const;

const LOCAL_DELETE_NOTE = "The session on your computer will not come back to your chats, even if you resume it. A new session starts a new chat.";

/**
 * A conversation's options: share it read-only, offer it to be forked, pin it above the date groups or unpin it,
 * rename it, or delete it and its document. Shown from the chat's header for the open conversation and from every row
 * of the sidebar, so the destructive confirmation is written once.
 *
 * Share and Fork are links rather than panes of their own: the dialog lives at the chat's own address, so it can be reached
 * from anywhere and the browser's back button closes it.
 *
 * Dismissed by Escape or a click outside, in the same shape as the hub's other menus: closing from the keyboard puts
 * focus back on the trigger, while a click elsewhere leaves focus where the click put it. The panel opens upward when
 * there is no room for it below.
 */
export function ChatMenu({
  title,
  shareHref,
  forkHref,
  noun = "chat",
  pinned,
  onPin,
  onRename,
  onDelete,
  onOpen,
  local = false,
  label = "Chat options",
  triggerClassName = TRIGGER,
  move
}: {
  title: string;
  /** Where the share dialog for this chat is. A thing that cannot be shared has no Share item. */
  shareHref?: string;
  /** Where the dialog offering this chat to be forked is. Without it there is no Fork item. */
  forkHref?: string;
  /** What the item is called in the rename box and the delete question: a chat, a form or a folder. */
  noun?: keyof typeof NOUNS;
  /** Whether the chat is pinned, which makes the item Unpin. */
  pinned?: boolean;
  /** Called with the state the person asked for: true to pin, false to unpin. A thing that cannot be pinned has no Pin item. */
  onPin?: (pinned: boolean) => Promise<void>;
  onRename: (title: string) => Promise<void>;
  onDelete: () => Promise<void>;
  /** Called as the menu opens, so whatever is shown about the last attempt can be dropped. */
  onOpen?: () => void;
  /**
   * A chat with a session on the person's own computer. Deleting one is permanent for that session, which the hub
   * never gives a chat again, so the confirmation says so.
   */
  local?: boolean;
  /** The accessible name of the trigger and of the menu. Name the chat wherever more than one menu is on the page. */
  label?: string;
  triggerClassName?: string;
  /**
   * The person's folders and the one the chat is in, null for none, and how to move it. Without it there is no Move to
   * folder item.
   */
  move?: {
    folders: readonly MoveTarget[];
    current: string | null;
    onMove: (folderId: string | null) => Promise<void>;
    /**
     * Makes a folder of the name typed and moves the chat into it, answering a refusal to show in the pane, or null once
     * it is done. Without it there is no New folder item.
     */
    onCreate?: (name: string) => Promise<string | null>;
  };
}) {
  const [open, setOpen] = useState<"closed" | "menu" | "rename" | "delete" | "move">("closed");
  const [draft, setDraft] = useState(title);
  const [problem, setProblem] = useState<string | null>(null);
  const [above, setAbove] = useState(false);
  const [width, setWidth] = useState(PANEL_WIDTH);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleBox = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const keepChat = useRef<HTMLButtonElement>(null);
  const moveList = useRef<HTMLDivElement>(null);
  const folderBox = useRef<HTMLInputElement>(null);
  // Whether the Move to folder pane is asking for a new folder's name, and the name typed so far.
  const [naming, setNaming] = useState(false);
  const [folderDraft, setFolderDraft] = useState("");
  const [running, setRunning] = useState(false);
  // Read as well as shown: two presses before the next render both see `running` false.
  const busy = useRef(false);

  const close = useCallback(() => {
    if (ref.current?.contains(document.activeElement)) {
      trigger.current?.focus();
    }
    setOpen("closed");
  }, []);

  // Focus goes into each pane as it opens: the menu's first item, the title box, or Cancel on the delete question,
  // which is the safe answer to land on. Otherwise the item that was pressed goes with the pane it was in, and focus
  // falls to the top of the page.
  useEffect(() => {
    if (open === "menu") {
      menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    } else if (open === "rename") {
      titleBox.current?.focus();
    } else if (open === "delete") {
      keepChat.current?.focus();
    } else if (open === "move") {
      moveList.current?.querySelector<HTMLElement>("[data-folder]:not(:disabled), [data-new-folder]")?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (naming) {
      folderBox.current?.focus();
    }
  }, [naming]);

  /** The menu's keys, as every menu in the Assistant answers them. */
  function moveInMenu(event: React.KeyboardEvent<HTMLDivElement>): void {
    moveFocusInMenu(event, [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]);
  }

  useDismiss(open !== "closed", ref, close);

  /** Opens a pane, forgetting whatever the last attempt reported. */
  function show(next: "menu" | "rename" | "delete" | "move"): void {
    setProblem(null);
    setNaming(false);
    setFolderDraft("");
    setOpen(next);
  }

  /** Makes the folder typed and moves the chat into it; a refusal stays in the pane, beside the name, to be corrected. */
  async function createAndMove(create: (name: string) => Promise<string | null>): Promise<void> {
    if (busy.current) {
      return;
    }
    busy.current = true;
    setProblem(null);
    setRunning(true);
    try {
      const refusal = await create(folderDraft);
      if (refusal !== null) {
        setProblem(refusal);
        return;
      }
    } catch (error) {
      setProblem(actionThrew(error, UNREACHABLE("new folder")));
      return;
    } finally {
      busy.current = false;
      setRunning(false);
    }
    close();
  }

  function toggle(): void {
    if (open !== "closed") {
      close();
      return;
    }
    const placed = panelPlacement(trigger.current);
    setAbove(placed.above);
    setWidth(placed.width);
    onOpen?.();
    show("menu");
  }

  /**
   * Runs one of the actions. An action answers its own refusal, which belongs beside the chat rather than in a
   * panel over it, so the panel closes on any answer at all and stays open only when none arrived.
   */
  async function run(what: string, work: () => Promise<void>): Promise<void> {
    if (busy.current) {
      return;
    }
    busy.current = true;
    setProblem(null);
    setRunning(true);
    try {
      await work();
    } catch (error) {
      setProblem(actionThrew(error, UNREACHABLE(what)));
      return;
    } finally {
      busy.current = false;
      setRunning(false);
    }
    close();
  }

  const item = "rounded-lg px-2.5 py-2 text-left text-sm hover:bg-asst-active";
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open !== "closed"}
        onClick={toggle}
        className={triggerClassName}
      >
        ⋯
      </button>
      {open === "closed" ? null : (
        <div
          style={{ width }}
          className={`absolute right-0 z-30 flex flex-col gap-0.5 rounded-xl border border-asst-strong bg-asst-hover p-1.5 shadow-2xl ${
            above ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]"
          }`}
        >
          {open === "menu" ? (
            <div ref={menu} role="menu" aria-label={label} onKeyDown={moveInMenu} className="flex flex-col gap-0.5">
              {shareHref === undefined ? null : (
                <Link href={shareHref} role="menuitem" className={item} onClick={() => close()}>
                  Share
                </Link>
              )}
              {forkHref === undefined ? null : (
                <Link href={forkHref} role="menuitem" className={item} onClick={() => close()}>
                  Fork
                </Link>
              )}
              {onPin === undefined ? null : (
                <button type="button" role="menuitem" className={item} onClick={() => void run(pinned ? "unpin" : "pin", () => onPin(!pinned))}>
                  {pinned ? "Unpin" : "Pin"}
                </button>
              )}
              {move === undefined ? null : (
                <button type="button" role="menuitem" className={item} onClick={() => show("move")}>
                  Move to folder
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                className={item}
                onClick={() => {
                  setDraft(title);
                  show("rename");
                }}
              >
                Rename
              </button>
              <button type="button" role="menuitem" className={`${item} text-asst-error`} onClick={() => show("delete")}>
                Delete {noun}
              </button>
            </div>
          ) : open === "move" && move !== undefined ? (
            <div ref={moveList} role="group" aria-label="Move to folder" className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1 pb-0.5">
                <button
                  type="button"
                  aria-label="Back to chat options"
                  title="Back"
                  onClick={() => show("menu")}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-asst-muted hover:bg-asst-active hover:text-asst-text"
                >
                  <span aria-hidden="true">←</span>
                </button>
                <p className="text-xs text-asst-faint">Move to folder</p>
              </div>
              {move.onCreate === undefined ? null : naming ? (
                <form
                  method="post"
                  className="flex flex-col gap-1.5 px-1 pb-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (move.onCreate !== undefined) {
                      void createAndMove(move.onCreate);
                    }
                  }}
                >
                  <label className="flex flex-col gap-1">
                    <span className="sr-only">New folder name</span>
                    <input
                      ref={folderBox}
                      value={folderDraft}
                      maxLength={FOLDER_NAME_MAX}
                      placeholder="Folder name"
                      onChange={(event) => setFolderDraft(event.target.value)}
                      className="rounded-lg border border-asst-strong bg-asst-field px-2.5 py-1.5 text-sm outline-hidden focus:border-asst-accent-line"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={running}
                    className="self-end rounded-lg bg-asst-accent px-3 py-1 text-sm font-semibold text-asst-ink disabled:opacity-60"
                  >
                    {running ? "Creating…" : "Create and move"}
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  data-new-folder=""
                  onClick={() => {
                    setProblem(null);
                    setNaming(true);
                  }}
                  className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-asst-active"
                >
                  <span aria-hidden="true" className="w-3 text-center text-asst-accent">
                    +
                  </span>
                  New folder
                </button>
              )}
              {move.folders.length === 0 ? (
                move.onCreate === undefined ? (
                  <p className="px-2.5 pb-1.5 text-sm text-asst-muted">You have no folders yet. Make one with the + beside Folders.</p>
                ) : null
              ) : (
                // Scrolls once there are more folders than fit, so the pane keeps to the room the menu was placed in.
                <div aria-label="Folders" role="list" className="flex max-h-[180px] flex-col gap-0.5 overflow-y-auto overscroll-contain">
                  {move.folders.map((folder) => (
                    <div role="listitem" key={folder.id}>
                      <MoveButton label={folder.name} chosen={move.current === folder.id} onPick={() => void run("move", () => move.onMove(folder.id))} />
                    </div>
                  ))}
                </div>
              )}
              {move.current === null ? null : <MoveButton label="Remove from folder" chosen={false} onPick={() => void run("move", () => move.onMove(null))} />}
            </div>
          ) : open === "rename" ? (
            <form
              method="post"
              className="flex flex-col gap-2 p-1"
              onSubmit={(event) => {
                event.preventDefault();
                void run("new name", () => onRename(draft));
              }}
            >
              {/* The box is inside its label, so nothing has to be unique to the one menu that is open. */}
              <label className="flex flex-col gap-2">
                <span className="text-xs text-asst-faint">{NOUNS[noun].field}</span>
                <input
                  ref={titleBox}
                  value={draft}
                  maxLength={NOUNS[noun].max}
                  onChange={(event) => setDraft(event.target.value)}
                  className="rounded-lg border border-asst-strong bg-asst-field px-2.5 py-1.5 text-sm outline-hidden focus:border-asst-accent-line"
                />
              </label>
              <button type="submit" className="self-end rounded-lg bg-asst-accent px-3 py-1.5 text-sm font-semibold text-asst-ink">
                Save
              </button>
            </form>
          ) : (
            <div className="flex flex-col gap-2 p-1">
              <p className="text-sm">{NOUNS[noun].ask}</p>
              {local ? <p className="text-sm">{LOCAL_DELETE_NOTE}</p> : null}
              <div className="flex justify-end gap-2">
                <button ref={keepChat} type="button" onClick={() => close()} className="rounded-lg border border-asst-strong px-3 py-1.5 text-sm">
                  Cancel
                </button>
                {/* Once only: a second press while the first is going would answer that the chat no longer exists. */}
                <button
                  type="button"
                  disabled={running}
                  onClick={() => void run("delete", onDelete)}
                  className="rounded-lg bg-asst-error px-3 py-1.5 text-sm font-semibold text-asst-ink disabled:opacity-60"
                >
                  {running ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          )}
          {problem === null ? null : (
            <p role="alert" className="px-1.5 pb-1 text-xs text-asst-error">
              {problem}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** One folder in the Move to folder pane; the one the chat is in already is shown as chosen. */
function MoveButton({ label, chosen, onPick }: { label: string; chosen: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      data-folder=""
      aria-pressed={chosen}
      disabled={chosen}
      onClick={onPick}
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-asst-active disabled:hover:bg-transparent"
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {chosen ? <span className="shrink-0 text-xs text-asst-muted">Current</span> : null}
    </button>
  );
}
