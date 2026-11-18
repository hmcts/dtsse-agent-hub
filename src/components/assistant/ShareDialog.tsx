"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type Ref, useEffect, useId, useRef, useState } from "react";
import { MIN_PEOPLE_QUERY } from "@/access/rules";
import type { SharePerson } from "@/assistant/shares";
import { AssistantModal } from "@/components/assistant/AssistantModal";
import { type SuggestionStatus, useSuggestions } from "@/components/useSuggestions";
import type { ActionResult } from "@/web/action";
import { SHARED_CHATS } from "@/web/home";

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
 * typed to the textarea it is attached to. Both halves of the behaviour are `useSuggestions`, which the post
 * composer's tag box shares; the markup stays here, because the two are styled for different pages.
 */

/**
 * `read` shares the chat to be read; `fork` offers it to be forked, which lets the people named read it on the same
 * page and take their own copy into their own CFT Workspace. One dialog for both, because choosing a person, the list and
 * the revocation are the same in each, and the two differ only in what the person named can do.
 */
export type ShareMode = "read" | "fork";

const WORDS: Record<ShareMode, { title: string; who: string; can: string; nobody: string; list: string; link: string }> = {
  read: {
    title: "Share this chat",
    who: "Who can read it",
    can: "can read",
    nobody: "This chat is not shared with anyone.",
    list: "Shared with",
    link: "The link opens the chat for the people above. Anyone else who is sent it sees nothing."
  },
  fork: {
    title: "Let someone fork this chat",
    who: "Who can fork it",
    can: "can fork",
    nobody: "Nobody has been offered this chat to fork.",
    list: "Offered to",
    link: "The link opens the chat for the people above, with a button to continue it in their own CFT Workspace. Anyone else who is sent it sees nothing."
  }
};

/** How long Undo is offered after someone is taken off. */
const UNDO_FOR_MS = 5000;

/** How long the Copy button reads "Copied" before it can be read as a button again. */
const COPIED_FOR_MS = 2000;

/** What the name box says under it, so an empty list says why it is empty. */
export function searchLine(status: SuggestionStatus, query: string, shown: number, found: boolean): string {
  switch (status) {
    case "short":
      return `Type at least ${MIN_PEOPLE_QUERY} letters.`;
    case "searching":
      return "Searching…";
    case "failed":
      return "Search is not working just now. Try again.";
    case "answered":
      if (shown > 0) {
        return `${shown === 1 ? "1 person matches" : `${shown} people match`}. Only people who have used the hub can be named.`;
      }
      return found ? `Everyone called "${query}" is already on the list.` : `No one called "${query}" has used the hub yet.`;
    default:
      return "Only people who have used the hub can be named.";
  }
}

export type ShareAction = (input: { conversationId: unknown; recipientOid: unknown }) => Promise<ActionResult<{ people: SharePerson[] }>>;

interface Candidate {
  oid: string;
  name: string;
  email: string | null;
}

/**
 * The body both surfaces share: what a recipient will see, the name box, the list with its removals, and the link to
 * copy. The modal over a chat and the inline editor in the settings' Sharing section each put their own frame round
 * it, which is where focusing it as it opens and closing it belong.
 *
 * What a recipient will see is said here rather than in either frame, because both are places a person is named from.
 */
export function ShareEditor({
  conversationId,
  people: initial,
  share,
  unshare,
  mode = "read",
  boxRef,
  onChange
}: {
  mode?: ShareMode;
  conversationId: string;
  people: readonly SharePerson[];
  share: ShareAction;
  unshare: ShareAction;
  /** The name box, for a frame that puts focus in it as it opens. */
  boxRef?: Ref<HTMLInputElement>;
  /** Called once a change is saved, for a frame that shows something the change alters. */
  onChange?: () => void;
}) {
  const router = useRouter();
  const words = WORDS[mode];
  const ids = useId();
  const listId = `${ids}-people`;
  const [people, setPeople] = useState<readonly SharePerson[]>(initial);
  const [fromPage, setFromPage] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"no" | "yes" | "by-hand">("no");
  const [removed, setRemoved] = useState<SharePerson | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const path = `/assistant/shared/${conversationId}`;
  // The whole address, once there is a browser to ask for the origin: the server has no origin to render, and a first
  // render that disagreed with the server's would be a hydration mismatch on the box's value.
  const [link, setLink] = useState(path);

  // The list is held here as well as read from the page, because sharing answers with the new one and the editor shows
  // it at once rather than waiting for the page to be read again. A page that has been read again wins: the server's
  // list is the real one, and without this the editor would keep its first answer for as long as it stayed open.
  if (fromPage !== initial) {
    setFromPage(initial);
    setPeople(initial);
  }

  useEffect(() => setLink(`${window.location.origin}${path}`), [path]);

  useEffect(
    () => () => {
      for (const timer of [copiedTimer.current, undoTimer.current]) {
        if (timer !== null) {
          clearTimeout(timer);
        }
      }
    },
    []
  );

  const suggestions = useSuggestions<Candidate>({
    path: "/api/ui/people",
    field: "people",
    minQuery: MIN_PEOPLE_QUERY,
    exclude: (candidate) => people.some((person) => person.oid === candidate.oid),
    onChoose: (candidate) => void run(share, candidate.oid)
  });
  const { shown, open, current } = suggestions;
  const optionId = (index: number) => `${listId}-${index}`;

  /** Whether the change was saved, for a caller that says something once it has been. */
  async function run(action: ShareAction, recipientOid: string): Promise<boolean> {
    setPending(true);
    setError(null);
    forget();
    try {
      const result = await action({ conversationId, recipientOid });
      if (result.ok) {
        setPeople(result.people);
        suggestions.clear();
        // The chat's own page shows nothing about its shares, but the sidebar does.
        router.refresh();
        onChange?.();
        return true;
      }
      setError(result.error);
    } catch {
      setError("That could not be saved. Check your connection and try again.");
    } finally {
      setPending(false);
    }
    return false;
  }

  /** Puts the last removal's Undo away, which any later change does: it would undo something no longer the latest. */
  function forget(): void {
    if (undoTimer.current !== null) {
      clearTimeout(undoTimer.current);
      undoTimer.current = null;
    }
    setRemoved(null);
  }

  /**
   * Taking someone off is the revocation and takes effect at once, so it is offered back for a few seconds rather than
   * asked about first: a removal is quick to make by mistake, and a question before every one would be slow to answer.
   */
  async function remove(person: SharePerson): Promise<void> {
    if (await run(unshare, person.oid)) {
      setRemoved(person);
      undoTimer.current = setTimeout(() => setRemoved(null), UNDO_FOR_MS);
    }
  }

  async function copy(): Promise<void> {
    if (copiedTimer.current !== null) {
      clearTimeout(copiedTimer.current);
      copiedTimer.current = null;
    }
    try {
      await navigator.clipboard.writeText(link);
      setCopied("yes");
      copiedTimer.current = setTimeout(() => setCopied("no"), COPIED_FOR_MS);
    } catch {
      // No clipboard permission, so the box beside the button is the way: select it for them to copy by hand, and say so.
      const field = document.getElementById(`${ids}-link`);
      if (field instanceof HTMLInputElement) {
        field.select();
      }
      setCopied("by-hand");
    }
  }

  return (
    <>
      {mode === "fork" ? (
        <p className="text-pretty text-[13px] text-asst-body">
          The people you name can read this chat and its document, and can take <strong className="font-semibold text-asst-text">their own copy</strong> of it
          to carry on in their own CFT Workspace.
        </p>
      ) : (
        <p className="text-pretty text-[13px] text-asst-body">
          The people you name can <strong className="font-semibold text-asst-text">read</strong> this chat and its document. They cannot reply, rename or delete
          it, change the document, or open the files you attached — a message you attached files to says only how many, although a message you sent with a file
          and no words of your own may name it, and so may the chat's own name. They see the most recent part of the chat as it stood when they opened it, not
          as you carry on.
        </p>
      )}

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
          {words.who}
        </label>
        <div className="relative">
          <input
            ref={boxRef}
            id={`${ids}-who`}
            value={suggestions.query}
            disabled={pending}
            autoComplete="off"
            placeholder="Start typing a name"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={open ? optionId(current) : undefined}
            onChange={(event) => suggestions.setQuery(event.target.value)}
            onKeyDown={suggestions.onKeyDown}
            className="w-full rounded-lg border border-asst-strong bg-asst-field px-2.5 py-1.5 text-sm outline-hidden focus:border-asst-accent-line"
          />
          <div
            id={listId}
            role="listbox"
            aria-label="People"
            hidden={!open}
            // `flex` would override the `hidden` attribute and leave its border and padding as an empty box under the
            // name box, so the display class itself switches as well.
            className={`${open ? "flex" : "hidden"} absolute left-0 right-0 top-[calc(100%+4px)] z-10 max-h-56 flex-col overflow-y-auto rounded-xl border border-asst-strong bg-asst-raised p-1 shadow-2xl`}
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
        {/* Polite and always there, so why the list is empty is read out as it changes rather than left to guess. */}
        <p aria-live="polite" className={`text-xs ${suggestions.status === "failed" ? "text-asst-error" : "text-asst-faint"}`}>
          {searchLine(suggestions.status, suggestions.query.trim(), shown.length, suggestions.found)}
        </p>
      </form>

      {removed === null ? null : (
        <p role="status" className="flex flex-wrap items-center gap-2 text-[13px] text-asst-body">
          {removed.name} {mode === "fork" ? "can no longer fork this chat." : "can no longer read this chat."}
          <button
            type="button"
            disabled={pending}
            onClick={() => void run(share, removed.oid)}
            className="rounded-md px-1.5 text-asst-accent underline hover:text-asst-accent-hover"
          >
            Undo
          </button>
        </p>
      )}

      {people.length === 0 ? (
        <p className="text-[13px] text-asst-muted">{words.nobody}</p>
      ) : (
        <ul aria-label={words.list} className="flex flex-col gap-1">
          {people.map((person) => (
            <li key={person.oid} className="flex items-center gap-2 rounded-lg border border-asst-line px-2.5 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {person.name}
                {person.email === null ? null : <span className="ml-2 text-xs text-asst-faint">{person.email}</span>}
              </span>
              <span className="shrink-0 text-xs text-asst-faint">{words.can}</span>
              <button
                type="button"
                disabled={pending}
                onClick={() => void remove(person)}
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
            className="min-w-0 flex-1 rounded-lg border border-asst-strong bg-asst-field px-2.5 py-1.5 text-xs text-asst-muted outline-hidden"
          />
          <button type="button" onClick={() => void copy()} className="shrink-0 rounded-lg border border-asst-strong px-3 py-1.5 text-sm hover:bg-asst-field">
            {copied === "yes" ? "Copied" : "Copy"}
          </button>
        </div>
        {/* Mounted from the start, so the copy is announced: a region inserted with its words already in it often is not. */}
        <p role="status" className={copied === "by-hand" ? "text-xs text-asst-body" : "sr-only"}>
          {copied === "yes" ? "Link copied" : copied === "by-hand" ? "The link is selected. Press Ctrl+C, or Command+C on a Mac, to copy it." : ""}
        </p>
        <p className="text-xs text-asst-faint">{words.link}</p>
      </div>

      {error === null ? null : (
        <p role="alert" className="text-[13px] text-asst-error">
          {error}
        </p>
      )}
    </>
  );
}

/**
 * The editor as a modal over the chat, for the chat's own menu and the sidebar's `?share=1` and `?fork=1`. The frame
 * is the Assistant's: focus goes to the name box as it opens and stays in the dialog, the backdrop, the × and Escape
 * close it — Escape once the box has no list of its own to shut — and focus goes back to what opened it.
 */
export function ShareDialog({
  conversationId,
  people,
  share,
  unshare,
  onClose,
  mode = "read"
}: {
  mode?: ShareMode;
  conversationId: string;
  people: readonly SharePerson[];
  share: ShareAction;
  unshare: ShareAction;
  onClose: () => void;
}) {
  const box = useRef<HTMLInputElement>(null);
  return (
    <AssistantModal title={WORDS[mode].title} onClose={onClose} initialFocus={box} closeLabel="Close sharing" className="max-w-[520px]">
      <ShareEditor mode={mode} conversationId={conversationId} people={people} share={share} unshare={unshare} boxRef={box} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Every chat the person has shared or offered, and every one shared with them, in one place. */}
        <Link href={SHARED_CHATS} className="text-[13px] text-asst-accent underline hover:text-asst-accent-hover">
          See all your shared chats
        </Link>
        <button type="button" onClick={onClose} className="rounded-[10px] border border-asst-strong px-4 py-2.5 text-sm hover:bg-asst-active">
          Done
        </button>
      </div>
    </AssistantModal>
  );
}
