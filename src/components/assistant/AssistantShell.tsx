"use client";

import Link from "next/link";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { DateGroup } from "@/assistant/grouping";
import type { ConversationLink } from "@/assistant/views";

interface ShellContextValue {
  sidebarOpen: boolean;
  openSidebar: () => void;
}

const ShellContext = createContext<ShellContextValue>({ sidebarOpen: true, openSidebar: () => {} });

/** The button a page's header shows while the sidebar is collapsed, or always on a narrow screen. */
export function SidebarToggle() {
  const { sidebarOpen, openSidebar } = useContext(ShellContext);
  return (
    <button
      type="button"
      onClick={openSidebar}
      aria-label="Open sidebar"
      className={`-ml-2 h-10 w-10 shrink-0 items-center justify-center rounded-lg hover:bg-asst-field ${sidebarOpen ? "flex md:hidden" : "flex"}`}
    >
      <span aria-hidden="true" className="flex flex-col gap-1">
        <span className="block h-0.5 w-[18px] rounded bg-current" />
        <span className="block h-0.5 w-[18px] rounded bg-current" />
        <span className="block h-0.5 w-[18px] rounded bg-current" />
      </span>
    </button>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length === 0 ? "?" : `${parts[0]?.[0] ?? ""}${parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : ""}`.toUpperCase();
}

export function Mark({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const box =
    size === "lg" ? "h-10 w-10 rounded-[10px] text-[17px]" : size === "sm" ? "h-[26px] w-[26px] rounded-[7px] text-xs" : "h-7 w-7 rounded-[7px] text-[13px]";
  return (
    <span aria-hidden="true" className={`flex shrink-0 items-center justify-center bg-asst-accent font-semibold text-asst-ink ${box}`}>
      H
    </span>
  );
}

/**
 * The Assistant's frame: its sidebar of conversations, newest first under date headings, beside the page. On a wide
 * screen the sidebar collapses to give the chat the room; on a narrow one it is a drawer over the page.
 */
export function AssistantShell({
  viewerName,
  groups,
  activeId,
  hubLink,
  children
}: {
  viewerName: string;
  groups: { label: DateGroup; items: ConversationLink[] }[];
  activeId: string | null;
  /** Shown to people who also use the hub's own pages. */
  hubLink: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const [narrow, setNarrow] = useState(false);
  const sidebar = useRef<HTMLElement>(null);

  // A collapsed sidebar is out of the tab order. Set on the element itself, since React 18 and the React 19 the app
  // router runs disagree on how `inert` is written as a prop.
  useEffect(() => {
    sidebar.current?.toggleAttribute("inert", !open);
  }, [open]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => {
      setNarrow(query.matches);
      if (query.matches) {
        setOpen(false);
      }
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!narrow || !open) {
      return;
    }
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [narrow, open]);

  // A narrow screen's drawer closes once a conversation is picked.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closing on navigation is the point, so the effect keys on the active id it does not read
  useEffect(() => {
    if (narrow) {
      setOpen(false);
    }
  }, [activeId]);

  return (
    <ShellContext.Provider value={{ sidebarOpen: open, openSidebar: () => setOpen(true) }}>
      <div className="relative flex min-h-0 flex-1 overflow-hidden bg-asst-bg font-plex text-[15px] leading-normal text-asst-text">
        {narrow && open ? (
          <button type="button" aria-label="Close sidebar" onClick={() => setOpen(false)} className="fixed inset-0 z-[19] bg-black/55" />
        ) : null}
        <aside
          aria-label="Conversations"
          className={`z-20 flex h-full w-[272px] shrink-0 flex-col border-r border-asst-active bg-asst-rail transition-[margin,transform] duration-200 ${
            narrow ? `fixed left-0 top-0 ${open ? "translate-x-0" : "-translate-x-full"}` : open ? "ml-0" : "-ml-[272px]"
          }`}
          ref={sidebar}
        >
          <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
            <Mark />
            <span className="text-sm font-semibold">HMCTS Assistant</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-asst-muted hover:bg-asst-hover hover:text-asst-text"
            >
              <span aria-hidden="true" className="flex h-3.5 w-4 rounded-[3px] border-[1.5px] border-current">
                <span className="h-full w-[5px] border-r-[1.5px] border-current" />
              </span>
            </button>
          </div>
          <div className="px-3 pb-3 pt-1">
            <Link
              href="/assistant"
              className="flex w-full items-center gap-2.5 rounded-[10px] border border-asst-strong px-3 py-2.5 text-sm hover:bg-asst-hover"
            >
              <span aria-hidden="true" className="text-lg leading-none text-asst-accent">
                +
              </span>
              New chat
            </Link>
          </div>
          <nav aria-label="Chats" className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-2 pb-4 pt-1">
            {groups.length === 0 ? <p className="px-2.5 text-[13px] text-asst-faint">Your chats appear here.</p> : null}
            {groups.map((group) => (
              <div key={group.label} className="flex flex-col gap-0.5">
                <h2 className="px-2.5 pb-1.5 pt-1 text-xs font-medium text-asst-faint">{group.label}</h2>
                <ul className="flex flex-col gap-0.5">
                  {group.items.map((item) => (
                    <li key={item.id}>
                      <Link
                        href={`/assistant/${item.id}`}
                        aria-current={item.id === activeId ? "page" : undefined}
                        className={`block truncate rounded-lg px-2.5 py-2 text-sm ${
                          item.id === activeId ? "bg-asst-active text-asst-text" : "text-asst-body hover:bg-asst-raised"
                        }`}
                      >
                        {item.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
          <div className="flex items-center gap-2.5 border-t border-asst-active px-4 py-3">
            <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-asst-line text-xs font-semibold">
              {initials(viewerName)}
            </span>
            <span className="min-w-0 truncate text-sm font-medium">{viewerName}</span>
            {hubLink ? (
              <Link href="/" className="ml-auto shrink-0 rounded px-2 py-1 text-xs text-asst-muted hover:bg-asst-hover hover:text-asst-text">
                Agent Hub
              </Link>
            ) : null}
          </div>
        </aside>
        <main className="flex h-full min-w-0 flex-1 flex-col">{children}</main>
      </div>
    </ShellContext.Provider>
  );
}
