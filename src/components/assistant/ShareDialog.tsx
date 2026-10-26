"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { MIN_PEOPLE_QUERY } from "@/access/rules";
import type { SharePerson } from "@/assistant/shares";
import type { ActionResult } from "@/web/action";

/**
 * Sharing one chat, read-only, with people the owner names.
 *
 * Who is on the list is the whole of the access, so the dialog is built around the list rather than around the link:
 * the link is copied once and resolves only for the people named, and taking someone off is the revocation. It says
 * what a recipient will see before anything is shared, because the thread and the document go with the share and
 * the owner is the only person who knows what is in them.
 *
 * The name box follows the hub's two existing suggest-as-you-type surfaces: the fetch and its debounce from
 * `ChannelBuilder`, and the combobox semantics from `SkillMenu` — `aria-expanded`, `aria-controls`,
 * `aria-activedescendant`, `listbox`/`option`, and up, down, Enter and Escape. `useSkillMenu` itself does not fit:
 * it matches a "/" token inside a message as it is typed, locally, against a list the page already has, and is
 * typed to the textarea it is attached to.
 */

export type ShareAction = (input: { conversationId: unknown; recipientOid: unknown }) => Promise<ActionResult<{ people: SharePerson[] }>>;

interface Candidate {
  oid: string;
  name: string;
  email: string | null;
}

const SUGGEST_DEBOUNCE_MS = 200;

export function ShareDialog({
  conversationId,
  people: initial,
  share,
  unshare,
  onClose
}: {
  conversationId: string;
  people: readonly SharePerson[];
  share: ShareAction;
  unshare: ShareAction;
  onClose: () => void;
}) {
  const router = useRouter();
  const ids = useId();
  const listId = `${ids}-people`;
  const [people, setPeople] = useState<readonly SharePerson[]>(initial);
  const [fromPage, setFromPage] = useState(initial);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Candidate[]>([]);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  const path = `/assistant/shared/${conversationId}`;
  // The whole address, once there is a browser to ask for the origin: the server has no origin to render, and a first
  // render that disagreed with the server's would be a hydration mismatch on the box's value.
  const [link, setLink] = useState(path);

  // The list is held here as well as read from the page, because sharing answers with the new one and the dialog shows
  // it at once rather than waiting for the page to be read again. A page that has been read again wins: the server's
  // list is the real one, and without this the dialog would keep its first answer for as long as it stayed open.
  if (fromPage !== initial) {
    setFromPage(initial);
    setPeople(initial);
  }

  useEffect(() => box.current?.focus(), []);

  useEffect(() => setLink(`${window.location.origin}${path}`), [path]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const asked = query.trim();
    if (asked.length < MIN_PEOPLE_QUERY) {
      setMatches([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/ui/people?q=${encodeURIComponent(asked)}`, { signal: controller.signal })
        .then((response) => (response.ok ? response.json() : { people: [] }))
        .then((body: { people: Candidate[] }) => {
          setMatches(body.people);
          setActive(0);
        })
        .catch(() => undefined);
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const shown = matches.filter((candidate) => !people.some((person) => person.oid === candidate.oid));
  const open = !dismissed && shown.length > 0;
  const current = open ? Math.min(active, shown.length - 1) : -1;
  const optionId = (index: number) => `${listId}-${index}`;

  async function run(action: ShareAction, recipientOid: string): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const result = await action({ conversationId, recipientOid });
      if (result.ok) {
        setPeople(result.people);
        setQuery("");
        setMatches([]);
        // The chat's own page shows nothing about its shares, but the sidebar and the shared list do.
        router.refresh();
      } else {
        setError(result.error);
      }
    } catch {
      setError("that could not be saved; check your connection and try again");
    } finally {
      setPending(false);
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (!open) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current + (event.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
      return;
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const chosen = shown[current];
      if (chosen !== undefined) {
        void run(share, chosen.oid);
      }
      return;
    }
    if (event.key === "Escape") {
      // The list first, the dialog only once there is no list to shut.
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
    }
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // No clipboard permission, so the box beside the button is the way: select it for them to copy by hand.
      const field = document.getElementById(`${ids}-link`);
      if (field instanceof HTMLInputElement) {
        field.select();
      }
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-5">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        className="flex max-h-full w-full max-w-[520px] flex-col gap-4 overflow-y-auto rounded-2xl border border-asst-line bg-asst-hover p-[22px] shadow-2xl"
      >
        <h2 id={`${ids}-title`} className="text-lg font-semibold">
          Share this chat
        </h2>
        <p className="text-pretty text-[13px] text-asst-body">
          The people you name can <strong className="font-semibold text-asst-text">read</strong> this chat and its document. They cannot reply, rename or delete
          it, change the document, or open the files you attached — a message you attached files to says only how many, although a message you sent with a file
          and no words of your own may name it, and so may the chat's own name. They see the most recent part of the chat as it stood when they opened it, not
          as you carry on.
        </p>

        <form
          method="post"
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const chosen = shown[current];
            if (chosen !== undefined) {
              void run(share, chosen.oid);
            }
          }}
        >
          <label htmlFor={`${ids}-who`} className="text-xs text-asst-faint">
            Who can read it
          </label>
          <div className="relative">
            <input
              ref={box}
              id={`${ids}-who`}
              value={query}
              disabled={pending}
              autoComplete="off"
              placeholder="Start typing a name"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={listId}
              aria-activedescendant={open ? optionId(current) : undefined}
              onChange={(event) => {
                setDismissed(false);
                setQuery(event.target.value);
              }}
              onKeyDown={onKeyDown}
              className="w-full rounded-lg border border-asst-strong bg-asst-field px-2.5 py-1.5 text-sm outline-none focus:border-asst-accent-line"
            />
            <div
              id={listId}
              role="listbox"
              aria-label="People"
              hidden={!open}
              className="absolute left-0 right-0 top-[calc(100%+4px)] z-10 flex max-h-56 flex-col overflow-y-auto rounded-xl border border-asst-strong bg-asst-raised p-1 shadow-2xl"
            >
              {open
                ? shown.map((candidate, index) => (
                    <div
                      key={candidate.oid}
                      id={optionId(index)}
                      role="option"
                      tabIndex={-1}
                      aria-selected={index === current}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => void run(share, candidate.oid)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          void run(share, candidate.oid);
                        }
                      }}
                      className={`flex cursor-pointer flex-col rounded-lg px-2.5 py-1.5 text-left text-sm ${index === current ? "bg-asst-active" : ""}`}
                    >
                      <span>{candidate.name}</span>
                      {candidate.email === null ? null : <span className="text-xs text-asst-faint">{candidate.email}</span>}
                    </div>
                  ))
                : null}
            </div>
          </div>
          <p className="text-xs text-asst-faint">Only people who have used the hub can be named.</p>
        </form>

        {people.length === 0 ? (
          <p className="text-[13px] text-asst-muted">This chat is not shared with anyone.</p>
        ) : (
          <ul aria-label="Shared with" className="flex flex-col gap-1">
            {people.map((person) => (
              <li key={person.oid} className="flex items-center gap-2 rounded-lg border border-asst-line px-2.5 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {person.name}
                  {person.email === null ? null : <span className="ml-2 text-xs text-asst-faint">{person.email}</span>}
                </span>
                <span className="shrink-0 text-xs text-asst-faint">can read</span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void run(unshare, person.oid)}
                  className="shrink-0 rounded-md px-1.5 text-xs text-asst-error hover:bg-asst-field"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${ids}-link`} className="text-xs text-asst-faint">
            Their link
          </label>
          <div className="flex gap-2">
            <input
              id={`${ids}-link`}
              readOnly
              value={link}
              className="min-w-0 flex-1 rounded-lg border border-asst-strong bg-asst-field px-2.5 py-1.5 text-xs text-asst-muted outline-none"
            />
            <button type="button" onClick={() => void copy()} className="shrink-0 rounded-lg border border-asst-strong px-3 py-1.5 text-sm hover:bg-asst-field">
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-xs text-asst-faint">The link opens the chat for the people above. Anyone else who is sent it sees nothing.</p>
        </div>

        {error === null ? null : (
          <p role="alert" className="text-[13px] text-asst-error">
            {error}
          </p>
        )}

        <div className="flex justify-end">
          <button type="button" onClick={onClose} className="rounded-[10px] border border-asst-strong px-4 py-2.5 text-sm hover:bg-asst-active">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
