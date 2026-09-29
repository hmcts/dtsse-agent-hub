"use client";

import { useState } from "react";
import { SendIcon } from "@/components/sidebar/icons";
import type { ApiMessage } from "@/messages/shape";
import { MAX_POST_TOPICS } from "@/topics/slug";
import type { ActionResult } from "@/web/action";

export type PostAction = (input: { topics: string[]; title: string; body: string; inReplyTo: string | null }) => Promise<ActionResult<{ message: ApiMessage }>>;

/** The topics a new post starts with: all of the view's, or its first `MAX_POST_TOPICS` when it has more. */
export function defaultTopics(topics: readonly string[]): string[] {
  return topics.slice(0, MAX_POST_TOPICS);
}

/** Enter sends and Shift+Enter starts a new line, as in Slack. */
export function submitOnEnter(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
}

export const SEND_BUTTON =
  "inline-flex h-7 items-center gap-1 rounded bg-[#007a5a] px-2.5 text-[13px] font-bold text-white hover:bg-[#148567] disabled:cursor-not-allowed disabled:bg-transparent disabled:text-hub-muted";

/**
 * Posts to the view's topics as the signed-in person. The limits shown here are a courtesy; the action checks them
 * again, because a server action can be called without this form.
 */
export function Composer({
  topics,
  post,
  replyTo,
  onCancelReply,
  onPosted
}: {
  topics: readonly string[];
  post: PostAction;
  replyTo: ApiMessage | null;
  onCancelReply: () => void;
  onPosted: (message: ApiMessage) => void;
}) {
  const [chosen, setChosen] = useState<string[]>(() => defaultTopics(topics));
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const tooMany = chosen.length > MAX_POST_TOPICS;
  const none = chosen.length === 0;
  const blocked = pending || none || tooMany || body.trim() === "";

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (blocked) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await post({ topics: chosen, title, body, inReplyTo: replyTo?.id ?? null });
      if (result.ok) {
        setBody("");
        setTitle("");
        onPosted(result.message);
      } else {
        setError(result.error);
      }
    } catch {
      setError("the post could not be sent; check your connection and try again");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-hub-line bg-hub-pane focus-within:border-hub-muted" aria-label="New post">
      {replyTo ? (
        <p className="flex items-center gap-2 rounded-t-lg bg-hub-raised px-3 py-1.5 text-xs text-hub-muted">
          Replying to #{replyTo.id}
          <button type="button" className="text-hub-link hover:underline" onClick={onCancelReply}>
            Cancel reply
          </button>
        </p>
      ) : null}
      <label className="block">
        <span className="sr-only">Title (optional)</span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={300}
          placeholder="Title (optional)"
          className="w-full bg-transparent px-3 pt-2.5 text-[15px] font-bold text-white placeholder:font-normal placeholder:text-hub-muted focus:outline-none"
        />
      </label>
      <label className="block">
        <span className="sr-only">Message</span>
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={submitOnEnter}
          required
          rows={2}
          maxLength={32_000}
          placeholder="Write a post"
          className="block max-h-60 w-full resize-y bg-transparent px-3 py-1.5 text-[15px] text-hub-text placeholder:text-hub-muted focus:outline-none"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2 px-2 pb-2">
        <fieldset className="flex flex-wrap items-center gap-1">
          <legend className="sr-only">Post to topics</legend>
          {topics.map((topic) => (
            <label key={topic} className="cursor-pointer">
              <input
                type="checkbox"
                className="peer sr-only"
                checked={chosen.includes(topic)}
                onChange={(event) => setChosen((current) => (event.target.checked ? [...current, topic] : current.filter((entry) => entry !== topic)))}
              />
              <span className="inline-block rounded border border-hub-line px-1.5 py-0.5 text-xs text-hub-muted line-through peer-checked:border-[#1d9bd1]/40 peer-checked:bg-[#1d9bd1]/10 peer-checked:text-hub-link peer-checked:no-underline peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-hub-link">
                #{topic}
              </span>
            </label>
          ))}
        </fieldset>
        {none ? <span className="text-xs text-amber-300">pick at least one topic</span> : null}
        {tooMany ? <span className="text-xs text-amber-300">a post has at most {MAX_POST_TOPICS} topics</span> : null}
        {error ? (
          <span role="alert" className="text-xs text-red-300">
            {error}
          </span>
        ) : null}
        <button type="submit" disabled={blocked} className={`ml-auto ${SEND_BUTTON}`}>
          <SendIcon />
          <span className="sr-only">{pending ? "Posting" : "Post"}</span>
        </button>
      </div>
    </form>
  );
}
