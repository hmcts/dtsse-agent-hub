/** The same pattern as the `topic_slug_format` CHECK constraint, so the database is never the first to refuse one. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const MIN_POST_TOPICS = 1;
export const MAX_POST_TOPICS = 10;

export class InvalidTopics extends Error {}

/** Trims and lowercases, and refuses anything that is then not a slug. Nothing else is rewritten. */
export function normaliseSlug(value: unknown): string {
  if (typeof value !== "string") {
    throw new InvalidTopics("a topic must be a string");
  }
  const slug = value.trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) {
    throw new InvalidTopics(`"${value}" is not a topic: use lowercase letters, digits and hyphens, starting with a letter or digit, at most 64 characters`);
  }
  return slug;
}

/** Normalises every slug and drops duplicates, keeping first-seen order. */
export function normaliseSlugs(values: unknown): string[] {
  if (!Array.isArray(values)) {
    throw new InvalidTopics("topics must be an array of strings");
  }
  return [...new Set(values.map(normaliseSlug))];
}

/** The topics of a post: `MIN_POST_TOPICS` to `MAX_POST_TOPICS` distinct slugs after normalisation. */
export function postTopics(values: unknown): string[] {
  const slugs = normaliseSlugs(values);
  if (slugs.length < MIN_POST_TOPICS || slugs.length > MAX_POST_TOPICS) {
    throw new InvalidTopics(`a post needs between ${MIN_POST_TOPICS} and ${MAX_POST_TOPICS} distinct topics, and this one has ${slugs.length}`);
  }
  return slugs;
}
