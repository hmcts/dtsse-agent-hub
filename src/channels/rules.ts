import type { Match } from "../messages/feed.ts";
import { InvalidTopics, MAX_POST_TOPICS, MIN_POST_TOPICS, normaliseSlug } from "../topics/slug.ts";

/**
 * What makes a channel, and what makes a topic set in a URL. Shared by the channel builder, which checks as the
 * person types, and the server action that saves, which checks again because a direct POST skips the builder.
 *
 * A saved channel carries 1–5 topics, the same bounds as a post, so the composer on a channel can always post to
 * every one of its topics. A `/c?topics=` view is not saved and may name more.
 */

export const MAX_CHANNEL_NAME = 80;
export const MAX_VIEW_TOPICS = 20;

export interface ChannelDraft {
  name: string;
  topics: string[];
  match: Match;
  shared: boolean;
}

export interface ChannelErrors {
  name?: string;
  topics?: string;
}

export type ChannelCheck = { ok: true; channel: ChannelDraft } | { ok: false; errors: ChannelErrors };

export function parseMatch(value: unknown): Match {
  return value === "all" ? "all" : "any";
}

/** Normalises every slug, dropping duplicates in first-seen order, and reports the first one that is not a slug. */
function topicList(values: unknown): { topics: string[]; error?: string } {
  if (!Array.isArray(values)) {
    return { topics: [], error: "pick at least one topic" };
  }
  const topics: string[] = [];
  for (const value of values) {
    try {
      const slug = normaliseSlug(value);
      if (!topics.includes(slug)) {
        topics.push(slug);
      }
    } catch (error) {
      return { topics, error: error instanceof InvalidTopics ? error.message : String(error) };
    }
  }
  return { topics };
}

export function checkChannel(input: { name: unknown; topics: unknown; match: unknown; shared: unknown }): ChannelCheck {
  const errors: ChannelErrors = {};
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name === "") {
    errors.name = "give the channel a name";
  } else if (name.length > MAX_CHANNEL_NAME) {
    errors.name = `a channel name is at most ${MAX_CHANNEL_NAME} characters`;
  }

  const { topics, error } = topicList(input.topics);
  if (error !== undefined) {
    errors.topics = error;
  } else if (topics.length < MIN_POST_TOPICS || topics.length > MAX_POST_TOPICS) {
    errors.topics = `a channel has between ${MIN_POST_TOPICS} and ${MAX_POST_TOPICS} topics, and this one has ${topics.length}`;
  }

  if (errors.name !== undefined || errors.topics !== undefined) {
    return { ok: false, errors };
  }
  return { ok: true, channel: { name, topics, match: parseMatch(input.match), shared: input.shared === true || input.shared === "on" } };
}

export interface ViewTopics {
  topics: string[];
  /** What was asked for and is not a slug, to say so rather than silently drop it. */
  invalid: string[];
}

/** `?topics=a,b` (or repeated `?topics=`) as normalised slugs, at most `MAX_VIEW_TOPICS`. */
export function viewTopics(value: string | string[] | undefined): ViewTopics {
  const raw = (Array.isArray(value) ? value : [value ?? ""]).flatMap((part) => part.split(",")).map((part) => part.trim());
  const topics: string[] = [];
  const invalid: string[] = [];
  for (const part of raw) {
    if (part === "") {
      continue;
    }
    try {
      const slug = normaliseSlug(part);
      if (!topics.includes(slug) && topics.length < MAX_VIEW_TOPICS) {
        topics.push(slug);
      }
    } catch {
      invalid.push(part);
    }
  }
  return { topics, invalid };
}

/** The shareable URL of an ad-hoc view. */
export function viewHref(topics: readonly string[], match: Match): string {
  const query = new URLSearchParams({ topics: topics.join(",") });
  if (match === "all") {
    query.set("mode", "all");
  }
  return `/c?${query.toString().replaceAll("%2C", ",")}`;
}
