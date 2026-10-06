"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { checkChannel, MAX_CHANNEL_NAME } from "@/channels/rules";
import type { Match } from "@/messages/feed";
import { MAX_POST_TOPICS, normaliseSlug } from "@/topics/slug";
import type { ActionResult } from "@/web/action";

export type SaveChannelAction = (input: { name: string; topics: string[]; match: Match; shared: boolean }) => Promise<ActionResult<{ id: string }>>;

interface Suggestion {
  slug: string;
  message_count: number;
}

/** A topic typed into the search box, as the slug it would be, or the reason it is not one. */
export function typedTopic(value: string): { slug: string } | { error: string } {
  try {
    return { slug: normaliseSlug(value) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Pick `MIN_POST_TOPICS` to `MAX_POST_TOPICS` topics, any or all, a name and whether to share. `checkChannel` validates here as the person types and
 * again in the action that saves.
 */
export function ChannelBuilder({
  save,
  initialTopics = [],
  initialMatch = "any"
}: {
  save: SaveChannelAction;
  initialTopics?: string[];
  initialMatch?: Match;
}) {
  const router = useRouter();
  const ids = useId();
  const [topics, setTopics] = useState<string[]>(initialTopics.slice(0, MAX_POST_TOPICS));
  const [search, setSearch] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [match, setMatch] = useState<Match>(initialMatch);
  const [name, setName] = useState(initialTopics.slice(0, MAX_POST_TOPICS).join(" + "));
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    const prefix = search.trim().toLowerCase();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/ui/topics?prefix=${encodeURIComponent(prefix)}`, { signal: controller.signal })
        .then((response) => (response.ok ? response.json() : { topics: [] }))
        .then((body: { topics: Suggestion[] }) => setSuggestions(body.topics))
        .catch(() => undefined);
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search]);

  const check = checkChannel({ name, topics, match, shared });
  const typed = search.trim() === "" ? null : typedTopic(search);

  function add(slug: string): void {
    setTopics((current) => (current.includes(slug) ? current : [...current, slug]));
    setSearch("");
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setTouched(true);
    if (!check.ok) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await save({ name, topics, match, shared });
      if (result.ok) {
        router.push(`/channels/${result.id}`);
        router.refresh();
      } else {
        setError(result.error);
      }
    } catch {
      setError("the channel could not be saved; try again");
    } finally {
      setPending(false);
    }
  }

  const errors = check.ok ? {} : check.errors;

  return (
    <form method="post" onSubmit={submit} className="space-y-5" aria-label="Build a channel">
      <div className="space-y-2">
        <label htmlFor={`${ids}-search`} className="block text-sm font-medium text-hub-text">
          Topics <span className="text-hub-muted">(1 to {MAX_POST_TOPICS})</span>
        </label>
        <ul className="flex flex-wrap gap-2" aria-label="Chosen topics">
          {topics.map((topic) => (
            <li key={topic} className="flex items-center gap-1 rounded bg-hub-raised px-2 py-0.5 font-mono text-xs text-hub-link">
              #{topic}
              <button
                type="button"
                onClick={() => setTopics((current) => current.filter((entry) => entry !== topic))}
                className="text-hub-text hover:text-white"
                aria-label={`Remove ${topic}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <input
            id={`${ids}-search`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && typed !== null && "slug" in typed) {
                event.preventDefault();
                add(typed.slug);
              }
            }}
            placeholder="Search or type a topic"
            className="w-72 max-w-full rounded-md border border-hub-line bg-hub-pane px-2 py-1 font-mono text-sm text-hub-text placeholder:text-hub-muted"
          />
          <button
            type="button"
            disabled={typed === null || !("slug" in typed)}
            onClick={() => typed !== null && "slug" in typed && add(typed.slug)}
            className="rounded-md border border-hub-line px-3 py-1 text-sm text-hub-text hover:bg-hub-raised disabled:text-hub-muted"
          >
            Add topic
          </button>
        </div>
        {typed !== null && "error" in typed ? <p className="text-xs text-amber-300">{typed.error}</p> : null}
        {suggestions.length > 0 ? (
          <ul className="flex flex-wrap gap-2" aria-label="Suggested topics">
            {suggestions
              .filter((suggestion) => !topics.includes(suggestion.slug))
              .map((suggestion) => (
                <li key={suggestion.slug}>
                  <button
                    type="button"
                    onClick={() => add(suggestion.slug)}
                    className="rounded-md border border-hub-line px-2 py-0.5 font-mono text-xs text-hub-text hover:bg-hub-raised"
                  >
                    #{suggestion.slug} <span className="text-hub-muted">{suggestion.message_count}</span>
                  </button>
                </li>
              ))}
          </ul>
        ) : null}
        {touched && errors.topics ? (
          <p role="alert" className="text-xs text-red-300">
            {errors.topics}
          </p>
        ) : null}
      </div>

      <fieldset className="space-y-1">
        <legend className="text-sm font-medium text-hub-text">Show posts carrying</legend>
        <label className="mr-4 inline-flex items-center gap-1 text-sm text-hub-text">
          <input type="radio" name="match" value="any" checked={match === "any"} onChange={() => setMatch("any")} /> any of these topics
        </label>
        <label className="inline-flex items-center gap-1 text-sm text-hub-text">
          <input type="radio" name="match" value="all" checked={match === "all"} onChange={() => setMatch("all")} /> all of these topics
        </label>
      </fieldset>

      <div className="space-y-1">
        <label htmlFor={`${ids}-name`} className="block text-sm font-medium text-hub-text">
          Name
        </label>
        <input
          id={`${ids}-name`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={MAX_CHANNEL_NAME}
          className="w-72 max-w-full rounded-md border border-hub-line bg-hub-pane px-2 py-1 text-sm text-hub-text"
        />
        {touched && errors.name ? (
          <p role="alert" className="text-xs text-red-300">
            {errors.name}
          </p>
        ) : null}
      </div>

      <label className="flex items-center gap-2 text-sm text-hub-text">
        <input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} /> Share with everyone signed in
      </label>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-[#007a5a] px-3 py-1 text-sm font-medium text-white hover:bg-[#148567] disabled:bg-hub-raised disabled:text-hub-text"
        >
          {pending ? "Saving" : "Save channel"}
        </button>
        {error ? (
          <span role="alert" className="text-xs text-red-300">
            {error}
          </span>
        ) : null}
      </div>
    </form>
  );
}
