import type { Match, PostScope } from "../messages/feed.ts";
import { InvalidTopics, MAX_POST_TOPICS, MIN_POST_TOPICS, normaliseSlug, normaliseSlugs } from "../topics/slug.ts";

/**
 * What makes a channel, and what makes a topic set in a URL. Shared by the channel builder, which checks as the
 * person types, and the server action that saves, which checks again because a direct POST skips the builder.
 *
 * A saved channel carries `MIN_POST_TOPICS` to `MAX_POST_TOPICS` topics, the same bounds as a post, so the composer on a channel can always post to
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

/** `normaliseSlugs`, with its refusal as the message to show rather than thrown. */
function topicList(values: unknown): { topics: string[]; error?: string } {
  if (!Array.isArray(values)) {
    return { topics: [], error: "pick at least one topic" };
  }
  try {
    return { topics: normaliseSlugs(values) };
  } catch (error) {
    if (error instanceof InvalidTopics) {
      return { topics: [], error: error.message };
    }
    throw error;
  }
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

/**
 * The posts `/api/ui/stream` and `/api/ui/feed` are asked for: `?everything=1` for every post, otherwise `?topics=`.
 * Asking for both is refused rather than one silently winning.
 */
export function viewScope(query: URLSearchParams): { scope: PostScope } | { error: string } {
  const everything = query.get("everything");
  const { topics, invalid } = viewTopics(query.getAll("topics"));
  if (everything !== null) {
    if (everything !== "1") {
      return { error: "everything must be 1" };
    }
    if (topics.length > 0 || invalid.length > 0) {
      return { error: "ask for everything or for topics, not both" };
    }
    return { scope: "everything" };
  }
  if (invalid.length > 0) {
    return { error: `not topics: ${invalid.join(", ")}` };
  }
  return { scope: topics };
}

/** The shareable URL of an ad-hoc view. */
export function viewHref(topics: readonly string[], match: Match): string {
  const query = new URLSearchParams({ topics: topics.join(",") });
  if (match === "all") {
    query.set("mode", "all");
  }
  return `/c?${query.toString().replaceAll("%2C", ",")}`;
}
