import { type DeckOutline, type DeckSlide, jsonbText } from "./deck.ts";
import type { DeckAuthor } from "./deck-store.ts";

/**
 * The rules of a person's edits to their deck in the web UI, apart from the store: when a save amends the latest
 * version rather than writing the next, and what the version's summary says. See "Editing a deck in the browser" in
 * docs/agent-api.md.
 */

/** How long after a version is first written the same person's later saves still amend it. */
export const AMEND_WINDOW_MS = 10 * 60_000;

export const EDITED_SUMMARY = "Edited slides";
export const REORDERED_SUMMARY = "Reordered slides";

/** The latest version, as the amend rule reads it. */
export interface AmendableVersion {
  by: string;
  /** Who wrote it through the editor; null for a session's write, a restore and a fork's copy. */
  editorOid: string | null;
  createdAt: Date;
}

/**
 * Whether `editorOid`'s save amends the latest version in place: it is theirs, written through the editor, and first
 * written less than `AMEND_WINDOW_MS` ago. The caller has already refused a save whose base is not the latest
 * version and revision, which is the rest of the rule: nothing else has written since.
 */
export function amends(latest: AmendableVersion | null, editorOid: string, now: Date): boolean {
  if (latest === null || latest.by !== "user" || latest.editorOid !== editorOid) {
    return false;
  }
  const age = now.getTime() - latest.createdAt.getTime();
  return age >= 0 && age < AMEND_WINDOW_MS;
}

const canonical = (value: unknown): string => jsonbText(value) ?? "";

const byId = (slides: readonly DeckSlide[]): Map<string, string> => new Map(slides.map((slide, index) => [slide.id ?? `#${index}`, canonical(slide)]));

/**
 * What a version written from the editor says changed against the version the edits started from: `Reordered slides`
 * when the slides are the same ones, saying the same things, in another order, and `Edited slides` for anything else
 * or when there is nothing to compare with.
 */
export function editSummary(before: DeckOutline | undefined, after: DeckOutline): string {
  if (before === undefined) {
    return EDITED_SUMMARY;
  }
  const deckSame = canonical({ ...before, slides: [] }) === canonical({ ...after, slides: [] });
  const was = byId(before.slides);
  const now = byId(after.slides);
  const sameSlides = was.size === now.size && [...now].every(([id, text]) => was.get(id) === text);
  const order = (slides: readonly DeckSlide[]) => slides.map((slide, index) => slide.id ?? `#${index}`).join("\n");
  return deckSame && sameSlides && order(before.slides) !== order(after.slides) ? REORDERED_SUMMARY : EDITED_SUMMARY;
}

/**
 * Whether the session builds this version's .pptx itself, as it does each version it writes. A version the person
 * wrote, by editing or restoring, is only ever built when they ask for it, so the panel offers that at once.
 */
export function sessionBuildsIt(version: { updatedBy: DeckAuthor | null }): boolean {
  return version.updatedBy !== "user";
}
