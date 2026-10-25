"use client";

import Link from "next/link";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { DateGroup } from "@/assistant/grouping";
import type { Theme } from "@/assistant/theme";
import type { ConversationLink } from "@/assistant/views";
import { besideSidebar, SIDEBAR_DRAWER_MAX_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_WIDTH } from "@/components/assistant/layout";
import { ThemeSwitch } from "@/components/assistant/ThemeSwitch";
import { useResizableWidth } from "@/components/assistant/useResizableWidth";

interface ShellContextValue {
  sidebarOpen: boolean;
  openSidebar: () => void;
  /** How much of the row the sidebar takes: nothing while it is collapsed, or a drawer over the page. */
  sidebarWidth: number;
}

const ShellContext = createContext<ShellContextValue>({ sidebarOpen: true, openSidebar: () => {}, sidebarWidth: 0 });

/** How much of the row the Assistant's sidebar takes, which a panel on the other side of the chat must leave. */
export function useSidebarWidth(): number {
  return useContext(ShellContext).sidebarWidth;
}

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

/**
 * The Assistant's mark: the Tudor crown from GOV.UK Frontend's logo (`govuk-frontend` 6.6.0, `macros/logo.njk`), in
 * the text colour of whichever theme is showing. Decorative: every place it appears is named in words beside it.
 */
export function Mark({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const box = size === "lg" ? "h-10 w-10" : size === "sm" ? "h-[26px] w-[26px]" : "h-7 w-7";
  return (
    <span aria-hidden="true" className={`flex shrink-0 items-center justify-center text-asst-text ${box}`}>
      <svg viewBox="0 0 64 60" fill="currentColor" focusable="false" className="h-full w-full">
        <circle cx="20" cy="17.6" r="3.7" />
        <circle cx="10.2" cy="23.5" r="3.7" />
        <circle cx="3.7" cy="33.2" r="3.7" />
        <circle cx="31.7" cy="30.6" r="3.7" />
        <circle cx="43.3" cy="17.6" r="3.7" />
        <circle cx="53.2" cy="23.5" r="3.7" />
        <circle cx="59.7" cy="33.2" r="3.7" />
        <path d="M33.1,9.8c.2-.1.3-.3.5-.5l4.6,2.4v-6.8l-4.6,1.5c-.1-.2-.3-.3-.5-.5l1.9-5.9h-6.7l1.9,5.9c-.2.1-.3.3-.5.5l-4.6-1.5v6.8l4.6-2.4c.1.2.3.3.5.5l-2.6,8c-.9,2.8,1.2,5.7,4.1,5.7h0c3,0,5.1-2.9,4.1-5.7l-2.6-8ZM37,37.9s-3.4,3.8-4.1,6.1c2.2,0,4.2-.5,6.4-2.8l-.7,8.5c-2-2.8-4.4-4.1-5.7-3.8.1,3.1.5,6.7,5.8,7.2,3.7.3,6.7-1.5,7-3.8.4-2.6-2-4.3-3.7-1.6-1.4-4.5,2.4-6.1,4.9-3.2-1.9-4.5-1.8-7.7,2.4-10.9,3,4,2.6,7.3-1.2,11.1,2.4-1.3,6.2,0,4,4.6-1.2-2.8-3.7-2.2-4.2.2-.3,1.7.7,3.7,3,4.2,1.9.3,4.7-.9,7-5.9-1.3,0-2.4.7-3.9,1.7l2.4-8c.6,2.3,1.4,3.7,2.2,4.5.6-1.6.5-2.8,0-5.3l5,1.8c-2.6,3.6-5.2,8.7-7.3,17.5-7.4-1.1-15.7-1.7-24.5-1.7h0c-8.8,0-17.1.6-24.5,1.7-2.1-8.9-4.7-13.9-7.3-17.5l5-1.8c-.5,2.5-.6,3.7,0,5.3.8-.8,1.6-2.3,2.2-4.5l2.4,8c-1.5-1-2.6-1.7-3.9-1.7,2.3,5,5.2,6.2,7,5.9,2.3-.4,3.3-2.4,3-4.2-.5-2.4-3-3.1-4.2-.2-2.2-4.6,1.6-6,4-4.6-3.7-3.7-4.2-7.1-1.2-11.1,4.2,3.2,4.3,6.4,2.4,10.9,2.5-2.8,6.3-1.3,4.9,3.2-1.8-2.7-4.1-1-3.7,1.6.3,2.3,3.3,4.1,7,3.8,5.4-.5,5.7-4.2,5.8-7.2-1.3-.2-3.7,1-5.7,3.8l-.7-8.5c2.2,2.3,4.2,2.7,6.4,2.8-.7-2.3-4.1-6.1-4.1-6.1h10.6,0Z" />
      </svg>
    </span>
  );
}

/**
 * The Assistant's frame: its sidebar of conversations, newest first under date headings, beside the page. On a wide
 * screen the sidebar is dragged to the width the person wants and collapses to give the chat the room; on a narrow
 * one it is a drawer over the page, at its own width, whatever width was dragged on a wide screen.
 */
export function AssistantShell({
  viewerName,
  groups,
  activeId,
  hubLink,
  theme = "system",
  children
}: {
  viewerName: string;
  groups: { label: DateGroup; items: ConversationLink[] }[];
  activeId: string | null;
  /** Shown to people who also use the hub's own pages. */
  hubLink: boolean;
  /** The appearance the person chose, which the switch in the footer starts from. */
  theme?: Theme;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const [narrow, setNarrow] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const resize = useResizableWidth({
    storageKey: "hmcts-assistant-sidebar-width",
    label: "Resize sidebar",
    initial: SIDEBAR_WIDTH,
    min: SIDEBAR_MIN_WIDTH,
    ceiling: SIDEBAR_MAX_WIDTH,
    // The sidebar cannot see whether the document panel is open, so it leaves room for one wherever one would take a
    // column of the row.
    reserve: besideSidebar,
    edge: "left"
  });
  // The drawer is its own width over the page, so a width dragged on a wide screen never reaches it.
  const width = narrow ? SIDEBAR_WIDTH : resize.width;

  // A collapsed sidebar is out of the tab order. Set on the element itself, since React 18 and the React 19 the app
  // router runs disagree on how `inert` is written as a prop.
  useEffect(() => {
    sidebar.current?.toggleAttribute("inert", !open);
  }, [open]);

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${SIDEBAR_DRAWER_MAX_WIDTH}px)`);
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
    <ShellContext.Provider value={{ sidebarOpen: open, openSidebar: () => setOpen(true), sidebarWidth: narrow || !open ? 0 : width }}>
      <div className="relative flex min-h-0 flex-1 overflow-hidden bg-asst-bg font-plex text-[15px] leading-normal text-asst-text">
        {narrow && open ? (
          <button type="button" aria-label="Close sidebar" onClick={() => setOpen(false)} className="fixed inset-0 z-[19] bg-black/55" />
        ) : null}
        <aside
          aria-label="Conversations"
          className={`z-20 flex h-full shrink-0 flex-col border-r border-asst-active bg-asst-rail transition-[margin,transform] duration-200 ${
            narrow ? `fixed left-0 top-0 ${open ? "translate-x-0" : "-translate-x-full"}` : "relative"
          }`}
          style={{ width, marginLeft: narrow || open ? 0 : -width }}
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
          <div className="flex flex-col gap-2.5 border-t border-asst-active px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-asst-line text-xs font-semibold">
                {initials(viewerName)}
              </span>
              <span className="min-w-0 truncate text-sm font-medium">{viewerName}</span>
            </div>
            <div className="flex items-center gap-2">
              <ThemeSwitch initial={theme} />
              {hubLink ? (
                <Link href="/" className="ml-auto shrink-0 rounded px-2 py-1 text-xs text-asst-muted hover:bg-asst-hover hover:text-asst-text">
                  Agent Hub
                </Link>
              ) : null}
            </div>
          </div>
          {/* Dragging stops at the narrowest the titles stay readable at; collapsing the sidebar is the button's job,
              and the width dragged here is the one it comes back to. */}
          {narrow || !open ? null : (
            <div
              {...resize.separator}
              className="absolute -right-1 bottom-0 top-0 z-[2] w-2 cursor-col-resize hover:bg-asst-accent/25 focus:bg-asst-accent/40 focus:outline-none"
            />
          )}
        </aside>
        <main className="flex h-full min-w-0 flex-1 flex-col">{children}</main>
      </div>
    </ShellContext.Provider>
  );
}
