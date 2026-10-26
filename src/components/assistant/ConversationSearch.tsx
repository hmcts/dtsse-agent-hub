"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { MAX_QUERY, searchTerms } from "@/assistant/search";
import type { ConversationMatch } from "@/assistant/views";

/**
 * Finding one of the person's own chats from the sidebar, by a word in its title or in anything said in it.
 *
 * The results take the place of the date-grouped list rather than hanging over it: the sidebar is as narrow as 240px
 * and already has a drag handle down its inner edge, so a popover there would be both cramped and in the way. The
 * grouped list, and the options menu on each of its rows, come back untouched as soon as the box is emptied.
 *
 * The box is a combobox over a listbox of results, the same semantics as the composers' "/" menu in
 * `components/SkillMenu.tsx`: focus stays in the box, the arrows move `aria-activedescendant` through the options and
 * Enter opens the one it is on. That menu's own hook is not reused because it is a hook over a message being typed —
 * it reads a leading "/" token and writes a skill name back into the text — and a search box shares none of that.
 */

/** How long after the last keystroke the search runs, so a typed word is one request rather than one per letter. */
export const SEARCH_AFTER_MS = 180;

export type SearchChats = (query: string, signal: AbortSignal) => Promise<ConversationMatch[]>;

/**
 * What the list is showing, and why. A search in flight keeps the answer before it on screen rather than emptying
 * the list for as long as it takes: typing another letter would otherwise flicker the results away and back.
 */
interface Results {
  state: "idle" | "searching" | "found" | "failed";
  chats: ConversationMatch[];
}

const IDLE: Results = { state: "idle", chats: [] };

async function fetchChats(query: string, signal: AbortSignal): Promise<ConversationMatch[]> {
  const response = await fetch(`/api/ui/assistant/search?q=${encodeURIComponent(query)}`, { signal });
  if (!response.ok) {
    throw new Error(`the chat search answered ${response.status}`);
  }
  return ((await response.json()) as { chats: ConversationMatch[] }).chats;
}

/** What the live region reads out, and what the list shows above itself while a search is on. */
function summary(results: Results): string {
  if (results.state === "idle") {
    return "";
  }
  if (results.state === "searching") {
    return "Searching your chats…";
  }
  if (results.state === "failed") {
    return "Your chats could not be searched. Check your connection and try again.";
  }
  return results.chats.length === 0 ? "No chats match that." : `${results.chats.length} ${results.chats.length === 1 ? "chat" : "chats"} found.`;
}

export function ConversationSearch({ search = fetchChats, children }: { search?: SearchChats; children: React.ReactNode }) {
  const router = useRouter();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Results>(IDLE);
  const [active, setActive] = useState(0);

  // A query with no word worth searching for is not a search at all: the sidebar keeps its usual list and nothing is
  // asked of the server, because one letter matches nearly every chat.
  const searching = searchTerms(query).length > 0;
  const chats = results.chats;
  const current = chats.length === 0 ? -1 : Math.min(active, chats.length - 1);
  const optionId = (index: number) => `${listId}-${index}`;

  useEffect(() => {
    if (searchTerms(query).length === 0) {
      setResults(IDLE);
      return;
    }
    const controller = new AbortController();
    setResults((previous) => ({ state: "searching", chats: previous.chats }));
    setActive(0);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          setResults({ state: "found", chats: await search(query, controller.signal) });
        } catch {
          // An aborted request is this effect being replaced by the next keystroke, not a failure to report.
          if (!controller.signal.aborted) {
            setResults({ state: "failed", chats: [] });
          }
        }
      })();
    }, SEARCH_AFTER_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, search]);

  /** Opens a chat and empties the box, so the sidebar is back on its list with the chat just opened marked on it. */
  function open(chat: ConversationMatch): void {
    setQuery("");
    router.push(`/assistant/${chat.id}`);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      // Escape empties the box and nothing more. The shell closes its drawer on Escape from `window`, which would
      // otherwise take the whole sidebar away from under the search.
      if (query !== "") {
        event.preventDefault();
        event.stopPropagation();
        setQuery("");
      }
      return;
    }
    if (chats.length === 0) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current + (event.key === "ArrowDown" ? 1 : chats.length - 1)) % chats.length);
      return;
    }
    if (event.key === "Enter") {
      const chosen = chats[current];
      if (chosen !== undefined) {
        event.preventDefault();
        open(chosen);
      }
    }
  }

  const said = summary(results);
  return (
    <>
      <div className="px-3 pb-3">
        <input
          type="search"
          value={query}
          maxLength={MAX_QUERY}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Search chats"
          placeholder="Search chats"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={chats.length > 0}
          aria-controls={listId}
          aria-activedescendant={current === -1 ? undefined : optionId(current)}
          className="w-full rounded-[10px] border border-asst-strong bg-asst-field px-3 py-2 text-sm text-asst-text outline-none placeholder:text-asst-faint focus:border-asst-accent-line"
        />
      </div>
      <nav aria-label="Chats" className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-2 pb-4 pt-1">
        {searching ? null : children}
        <div className="flex flex-col gap-1">
          {/* The region is mounted whether or not a search is on, and is given no height rather than taken out of
              the layout, because a live region that appears along with its text is not reliably read out. */}
          <p role="status" className="px-2.5 text-[13px] text-asst-faint empty:h-0 empty:overflow-hidden">
            {said}
          </p>
          <div id={listId} role="listbox" aria-label="Chats found" hidden={chats.length === 0} className="flex flex-col gap-0.5">
            {chats.map((chat, index) => (
              <div
                key={chat.id}
                id={optionId(index)}
                role="option"
                tabIndex={-1}
                aria-selected={index === current}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => open(chat)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    open(chat);
                  }
                }}
                className={`flex cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 py-2 ${
                  index === current ? "bg-asst-active text-asst-text" : "text-asst-body hover:bg-asst-raised"
                }`}
              >
                <span className="truncate text-sm">{chat.title}</span>
                {chat.snippet === null ? null : <span className="line-clamp-2 text-xs text-asst-faint">{chat.snippet}</span>}
              </div>
            ))}
          </div>
        </div>
      </nav>
    </>
  );
}
