"use client";

import { useState } from "react";
import type { ApiMessage } from "@/messages/shape";
import { MAX_POST_TOPICS } from "@/topics/slug";
import type { ActionResult } from "@/web/action";

export type PostAction = (input: { topics: string[]; title: string; body: string; inReplyTo: string | null }) => Promise<ActionResult<{ message: ApiMessage }>>;

/** The topics a new post starts with: all of the view's, or its first five when it has more. */
export function defaultTopics(topics: readonly string[]): string[] {
  return topics.slice(0, MAX_POST_TOPICS);
}

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

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
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
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-slate-800 bg-slate-900 p-3" aria-label="New post">
      {replyTo ? (
        <p className="flex items-center gap-2 text-xs text-slate-300">
          Replying to #{replyTo.id}
          <button type="button" className="text-indigo-300 hover:text-indigo-200" onClick={onCancelReply}>
            Cancel reply
          </button>
        </p>
      ) : null}
      <fieldset className="flex flex-wrap items-center gap-3">
        <legend className="sr-only">Post to topics</legend>
        {topics.map((topic) => (
          <label key={topic} className="flex items-center gap-1 font-mono text-xs text-slate-300">
            <input
              type="checkbox"
              checked={chosen.includes(topic)}
              onChange={(event) => setChosen((current) => (event.target.checked ? [...current, topic] : current.filter((entry) => entry !== topic)))}
            />
            #{topic}
          </label>
        ))}
      </fieldset>
      <label className="block">
        <span className="sr-only">Title (optional)</span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={300}
          placeholder="Title (optional)"
          className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100 placeholder:text-slate-400"
        />
      </label>
      <label className="block">
        <span className="sr-only">Message</span>
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          required
          rows={3}
          maxLength={32_000}
          placeholder="Write a post"
          className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100 placeholder:text-slate-400"
        />
      </label>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending || none || tooMany || body.trim() === ""}
          className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-300"
        >
          {pending ? "Posting" : "Post"}
        </button>
        {none ? <span className="text-xs text-amber-300">pick at least one topic</span> : null}
        {tooMany ? <span className="text-xs text-amber-300">a post has at most {MAX_POST_TOPICS} topics</span> : null}
        {error ? (
          <span role="alert" className="text-xs text-red-300">
            {error}
          </span>
        ) : null}
      </div>
    </form>
  );
}
