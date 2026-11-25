"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FOLDER_NAME_MAX, folderHref } from "@/assistant/folders";
import { UNREACHABLE } from "@/components/assistant/ChatMenu";
import type { ActionResult } from "@/web/action";
import { actionThrew } from "@/web/action-fault";

/** A folder as the sidebar lists it, with its chats, most recently active first, for when it is expanded. */
export interface SidebarFolder {
  id: string;
  name: string;
  chats: readonly { id: string; title: string }[];
}

/** The viewer's folders and what the sidebar does with them: make one, and move a chat into one. */
export interface SidebarFolders {
  list: readonly SidebarFolder[];
  create: CreateFolderAction;
  move: MoveToFolderAction;
}

/** Makes a folder of a chat's options menu. */
export type CreateFolderAction = (input: { name: unknown }) => Promise<ActionResult<{ id: string }>>;

/** Moves a chat into a folder, or out of any with null. */
export type MoveToFolderAction = (input: { conversationId: unknown; folderId: unknown }) => Promise<ActionResult>;

/**
 * What a chat's Move to folder pane does with a new folder's name: makes the folder, then moves the chat into it,
 * answering the refusal of whichever step refused, or null once both are done. A folder made and then not moved into
 * is kept: it is the folder the person asked for, and the move can be tried again from the list.
 */
export async function createAndMoveInto(create: CreateFolderAction, move: MoveToFolderAction, conversationId: string, name: string): Promise<string | null> {
  const made = await create({ name });
  if (!made.ok) {
    return made.error;
  }
  const moved = await move({ conversationId, folderId: made.id });
  return moved.ok ? null : moved.error;
}

/** The outline of a folder, for a folder's row. Decorative: the row is named by the folder's name beside it. */
function FolderIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="h-4 w-4 shrink-0 text-asst-muted">
      <path d="M1.75 4.25a1 1 0 0 1 1-1h3.1l1.5 1.5h5.9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" strokeLinejoin="round" />
    </svg>
  );
}

/** The folders that hold what is open: the folder's own page, or a chat in it. */
function holding(list: readonly SidebarFolder[], activeId: string | null): string[] {
  return list.flatMap((folder) => (activeId === folderHref(folder.id) || folder.chats.some((chat) => chat.id === activeId) ? [folder.id] : []));
}

/** A chevron that points right while its folder is closed and down while it is open. Decorative: the button is named. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="M6 3.5 10.5 8 6 12.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The sidebar's Folders: a heading with a plus that names a new folder, and a row for each, which opens its page. Each
 * row expands to list every chat in the folder; the folder holding what is open starts expanded, and expands when a
 * chat in it is opened. The new folder's page opens once it is made, since starting a chat in it is the next thing to do.
 */
export function FolderList({ folders, activeId }: { folders: SidebarFolders; activeId: string | null }) {
  const router = useRouter();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(holding(folders.list, activeId)));

  // Opening a chat that is in a folder, or moving the open chat into one, shows where it is. Keyed on which folders
  // hold what is open, not on the list, so a folder the person closed stays closed while nothing moves.
  const holdingOpen = holding(folders.list, activeId).join(" ");
  useEffect(() => {
    if (holdingOpen !== "") {
      setExpanded((current) => new Set([...current, ...holdingOpen.split(" ")]));
    }
  }, [holdingOpen]);

  function toggle(id: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  }

  useEffect(() => {
    if (naming) {
      box.current?.focus();
    }
  }, [naming]);

  function stopNaming(): void {
    setNaming(false);
    setName("");
    setProblem(null);
    plus.current?.focus();
  }

  async function create(): Promise<void> {
    if (saving) {
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      const result = await folders.create({ name });
      if (!result.ok) {
        setProblem(result.error);
        return;
      }
      setNaming(false);
      setName("");
      router.push(folderHref(result.id));
    } catch (error) {
      setProblem(actionThrew(error, UNREACHABLE("new folder")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="sidebar-folders" className="flex flex-col gap-0.5">
      <div className="flex items-center">
        <h2 id="sidebar-folders" className="px-2.5 pb-1.5 pt-1 text-xs font-medium text-asst-faint">
          Folders
        </h2>
        <button
          ref={plus}
          type="button"
          aria-label="New folder"
          title="New folder"
          aria-expanded={naming}
          onClick={() => (naming ? stopNaming() : setNaming(true))}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-base leading-none text-asst-muted hover:bg-asst-field hover:text-asst-text"
        >
          <span aria-hidden="true">+</span>
        </button>
      </div>
      {naming ? (
        <form
          method="post"
          className="flex flex-col gap-1.5 px-1 pb-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="sr-only">Folder name</span>
            <input
              ref={box}
              value={name}
              maxLength={FOLDER_NAME_MAX}
              placeholder="Folder name"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  stopNaming();
                }
              }}
              className="rounded-lg border border-asst-strong bg-asst-field px-2.5 py-1.5 text-sm outline-hidden focus:border-asst-accent-line"
            />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={stopNaming} className="rounded-lg border border-asst-strong px-3 py-1 text-sm">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="rounded-lg bg-asst-accent px-3 py-1 text-sm font-semibold text-asst-ink disabled:opacity-60">
              {saving ? "Creating…" : "Create"}
            </button>
          </div>
          {problem === null ? null : (
            <p role="alert" className="text-xs text-asst-error">
              {problem}
            </p>
          )}
        </form>
      ) : null}
      {folders.list.length === 0 && !naming ? <p className="px-2.5 text-[13px] text-asst-faint">Group your chats into folders.</p> : null}
      <ul className="flex flex-col gap-0.5">
        {folders.list.map((folder) => {
          const href = folderHref(folder.id);
          const active = activeId === href;
          const open = expanded.has(folder.id);
          const chatsId = `folder-chats-${folder.id}`;
          return (
            <li key={folder.id}>
              <div className={`flex items-center rounded-lg ${active ? "bg-asst-active text-asst-text" : "text-asst-body hover:bg-asst-raised"}`}>
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={chatsId}
                  aria-label={`${open ? "Collapse" : "Expand"} ${folder.name}`}
                  onClick={() => toggle(folder.id)}
                  className="flex h-9 w-7 shrink-0 items-center justify-center rounded-l-lg text-asst-muted hover:text-asst-text"
                >
                  <Chevron open={open} />
                </button>
                <Link href={href} aria-current={active ? "page" : undefined} className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-2.5 text-sm">
                  <FolderIcon />
                  <span className="min-w-0 truncate">{folder.name}</span>
                </Link>
              </div>
              {open ? (
                <ul id={chatsId} aria-label={`Chats in ${folder.name}`} className="flex flex-col gap-0.5 pb-1 pl-7 pt-0.5">
                  {folder.chats.length === 0 ? <li className="px-2.5 py-1.5 text-[13px] text-asst-faint">No chats yet</li> : null}
                  {folder.chats.map((chat) => {
                    const current = chat.id === activeId;
                    return (
                      <li key={chat.id}>
                        <Link
                          href={`/assistant/${chat.id}`}
                          aria-current={current ? "page" : undefined}
                          className={`block truncate rounded-lg px-2.5 py-1.5 text-[13px] ${current ? "bg-asst-active text-asst-text" : "text-asst-body hover:bg-asst-raised"}`}
                        >
                          {chat.title}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
