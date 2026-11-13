"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { Timestamp } from "@/components/time/Timestamp";
import type { FeedbackThreadView } from "@/feedback/thread-store";
import { MentionInput, type MentionPerson } from "./MentionInput";

/**
 * One comment thread, as a card in the review shell's panel and the team's comments view: who raised it and when,
 * every comment with the people it names picked out, a reply box and Resolve or Reopen. Focusing the card (a click
 * or a keyboard focus inside it) tells the page, which points at the thread's element.
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `body` split into plain runs and the `@Name`s of the people the comment names, longest name first. */
export function mentionRuns(body: string, names: readonly string[]): { text: string; mention: boolean }[] {
  const wanted = [...new Set(names.filter((name) => name.trim() !== ""))].sort((left, right) => right.length - left.length);
  if (wanted.length === 0) {
    return [{ text: body, mention: false }];
  }
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])@(?:${wanted.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`, "giu");
  const runs: { text: string; mention: boolean }[] = [];
  let last = 0;
  for (const match of body.matchAll(pattern)) {
    if (match.index > last) {
      runs.push({ text: body.slice(last, match.index), mention: false });
    }
    runs.push({ text: match[0], mention: true });
    last = match.index + match[0].length;
  }
  if (last < body.length) {
    runs.push({ text: body.slice(last), mention: false });
  }
  return runs;
}

function CommentBody({ body, mentions, people }: { body: string; mentions: readonly string[]; people: readonly MentionPerson[] }) {
  const names = people.filter((person) => mentions.includes(person.oid)).map((person) => person.name.trim());
  return (
    <p className="whitespace-pre-wrap break-words text-sm text-asst-body">
      {mentionRuns(body, names).map((run, index) => (
        <Fragment key={index}>
          {run.mention ? <strong className="rounded bg-asst-accent-soft/20 px-0.5 font-semibold text-asst-accent">{run.text}</strong> : run.text}
        </Fragment>
      ))}
    </p>
  );
}

const STATUS_WORDS: Record<FeedbackThreadView["status"], string> = { open: "Open", resolved: "Resolved", detached: "Not found on the page" };

export function ThreadCard({
  thread,
  people,
  onReply,
  onStatus,
  focused = false,
  onFocus,
  number,
  missing = false
}: {
  thread: FeedbackThreadView;
  people: readonly MentionPerson[];
  /** Answers an error to show, or null once the reply is saved. */
  onReply: (body: string) => Promise<string | null>;
  onStatus: (status: "open" | "resolved") => Promise<string | null>;
  focused?: boolean;
  onFocus?: () => void;
  /** The thread's marker number on its page, when it has one. */
  number?: number;
  /** The widget could not find the thread's element on the page as it is now. */
  missing?: boolean;
}) {
  const card = useRef<HTMLElement>(null);
  const [reply, setReply] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolved = thread.status === "resolved";
  const headingId = `thread-${thread.id}`;

  useEffect(() => {
    if (focused) {
      card.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    }
  }, [focused]);

  const run = async (work: () => Promise<string | null>, after?: () => void) => {
    setPending(true);
    setError(null);
    const failure = await work();
    setPending(false);
    if (failure === null) {
      after?.();
    } else {
      setError(failure);
    }
  };

  const sendReply = () => {
    const body = reply.trim();
    if (body === "" || pending) {
      return;
    }
    void run(
      () => onReply(body),
      () => setReply("")
    );
  };

  const first = thread.comments[0];
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a click anywhere on the card is a pointer shortcut; the keyboard reaches the same through onFocusCapture, as focus enters the card.
    <article
      ref={card}
      aria-labelledby={headingId}
      onFocusCapture={onFocus}
      onClick={onFocus}
      className={`flex flex-col gap-2 rounded-xl border bg-asst-raised p-3 ${focused ? "border-asst-accent ring-2 ring-asst-accent-line" : "border-asst-line"} ${resolved ? "opacity-80" : ""}`}
    >
      <header className="flex items-start gap-2">
        {number === undefined ? null : (
          <span
            aria-hidden="true"
            className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${resolved ? "bg-asst-strong text-asst-text" : "bg-asst-accent text-asst-ink"}`}
          >
            {number}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="truncate text-sm font-semibold text-asst-text">
            {number === undefined ? "" : `Comment ${number}: `}
            {thread.author.name}
          </h3>
          <p className="text-xs text-asst-faint">
            {first === undefined ? null : <Timestamp iso={first.createdAt} />}
            <span> · {STATUS_WORDS[thread.status]}</span>
            {resolved && thread.resolvedBy !== null ? <span> by {thread.resolvedBy.name}</span> : null}
          </p>
        </div>
      </header>
      {missing && thread.status !== "detached" ? <p className="text-xs text-asst-warn">This comment's element is not on the page as it is now.</p> : null}
      <ol className="flex flex-col gap-2">
        {thread.comments.map((comment, index) => (
          <li key={comment.id} className={index === 0 ? "" : "border-l-2 border-asst-line pl-2"}>
            {index === 0 ? null : (
              <p className="text-xs text-asst-faint">
                <span className="font-semibold text-asst-muted">{comment.author.name}</span> · <Timestamp iso={comment.createdAt} />
              </p>
            )}
            <CommentBody body={comment.body} mentions={comment.mentions} people={people} />
          </li>
        ))}
      </ol>
      <MentionInput
        value={reply}
        onChange={setReply}
        people={people}
        label={`Reply to ${thread.author.name}`}
        placeholder="Reply…"
        rows={2}
        disabled={pending}
        onSubmit={sendReply}
      />
      {error === null ? null : (
        <p role="alert" className="text-[13px] text-asst-error">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => void run(() => onStatus(resolved ? "open" : "resolved"))}
          className="rounded-lg border border-asst-strong px-3 py-1 text-sm hover:bg-asst-field disabled:opacity-60"
        >
          {resolved ? "Reopen" : "Resolve"}
        </button>
        <button
          type="button"
          disabled={pending || reply.trim() === ""}
          onClick={sendReply}
          className="rounded-lg bg-asst-accent px-3 py-1 text-sm font-semibold text-asst-ink hover:bg-asst-accent-hover disabled:opacity-60"
        >
          Reply
        </button>
      </div>
    </article>
  );
}
