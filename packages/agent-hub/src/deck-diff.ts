/**
 * What changed between two versions of a deck, for the slides panel's "Compare with latest" and the client's
 * `agent-hub deck get --diff-from`. Slides are lined up by
 * id, which every stored slide has and keeps across versions (`withSlideIds`), so a slide whose title was rewritten is
 * still the same slide, and one moved to another place is moved rather than removed and added again.
 *
 * Text is compared word by word. A bullet list is compared as its lines, so a new bullet reads as added words on a
 * line of their own. Nothing here says how a change is drawn; the panel marks each with words and icons, never colour
 * alone.
 *
 * It imports nothing, because `packages/agent-hub/src/deck-diff.ts` is a byte-for-byte copy of it, held to it by
 * `deck-diff.test.ts`: the published client cannot import the hub's code, and the two must compare alike. Its types
 * are the outline's shape as `deck.ts` checks it, written out here for that reason.
 */

type Bullet = string | { text: string; bullets?: string[] };

interface SlideBase {
  id?: string;
  title: string;
  notes?: string;
}

/** One slide of a checked outline: `DeckSlide` in the hub's `deck.ts`. */
export type DeckSlide =
  | (SlideBase & { layout: "HMCTS_SECTION" })
  | (SlideBase & { layout: "HMCTS_CONTENT"; bullets: Bullet[] })
  | (SlideBase & { layout: "HMCTS_TWO_COLUMN"; left: Bullet[]; right: Bullet[] })
  | (SlideBase & { layout: "HMCTS_IMAGE"; image: { asset: string; alt?: string; decorative?: boolean }; caption?: string })
  | (SlideBase & { layout: "HMCTS_CLOSING"; subtitle?: string });

/** A checked outline: `DeckOutline` in the hub's `deck.ts`. */
export interface DeckOutline {
  title: string;
  subtitle?: string;
  notes?: string;
  slides: DeckSlide[];
}

export type WordKind = "same" | "added" | "removed";

/** A run of words that are in both versions, only the newer, or only the older. Leading space separates it from the run before. */
export interface WordPart {
  kind: WordKind;
  text: string;
}

export type FieldName = "title" | "subtitle" | "layout" | "bullets" | "left" | "right" | "picture" | "caption" | "notes";

export interface FieldChange {
  field: FieldName;
  /** The field as the panel names it. */
  label: string;
  parts: WordPart[];
  /** Something the words do not show, such as a picture replaced under the same alt text. */
  note?: string;
}

export type SlideStatus = "same" | "added" | "removed" | "moved" | "changed";

export interface SlidePlace {
  /** The slide's place in its version's outline, from 0; the drawn deck shows it as `index + 2`, after the title slide. */
  index: number;
  slide: DeckSlide;
}

export interface SlideDiff {
  /** The slide's id, or its place in the older or newer outline for one stored without an id. */
  id: string;
  /** `changed` wins over `moved`: a slide both moved and changed says so with `moved`. */
  status: SlideStatus;
  moved: boolean;
  before?: SlidePlace;
  after?: SlidePlace;
  fields: FieldChange[];
}

export interface DeckDiff {
  /** The title slide's own fields: the outline's title, subtitle and notes. */
  deck: FieldChange[];
  /** In the newer version's order, with each removed slide after the one it followed in the older. */
  slides: SlideDiff[];
  counts: { added: number; removed: number; moved: number; changed: number };
}

/** Past this many cells the word diff stops looking for common words and shows the field as replaced. */
export const MAX_DIFF_CELLS = 4_000_000;

const LINE = "\n";

function tokens(text: string): string[] {
  return text.match(/\n|[^\s]+/g) ?? [];
}

/** The longest common subsequence of `a` and `b`, as the pairs of indexes it keeps. */
function common<T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean): [number, number][] {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = same(a[i] as T, b[j] as T)
        ? (table[(i + 1) * width + j + 1] ?? 0) + 1
        : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (same(a[i] as T, b[j] as T)) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/** Tokens as runs, each word separated from the one before it by a space unless a line break is between them. */
function runs(marked: { kind: WordKind; token: string }[]): WordPart[] {
  const parts: WordPart[] = [];
  let previous: string | undefined;
  for (const { kind, token } of marked) {
    const space = previous !== undefined && previous !== LINE && token !== LINE ? " " : "";
    const last = parts.at(-1);
    if (last !== undefined && last.kind === kind) {
      last.text += space + token;
    } else {
      parts.push({ kind, text: space + token });
    }
    previous = token;
  }
  return parts;
}

/**
 * The words of `after` against those of `before`: what both have, what only the newer has, and what only the older
 * had, in reading order with the removed words before the added ones that replace them.
 */
export function diffWords(before: string, after: string): WordPart[] {
  const a = tokens(before);
  const b = tokens(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) {
    end += 1;
  }
  const midA = a.slice(start, a.length - end);
  const midB = b.slice(start, b.length - end);
  const marked: { kind: WordKind; token: string }[] = a.slice(0, start).map((token) => ({ kind: "same" as const, token }));
  if (midA.length * midB.length > MAX_DIFF_CELLS) {
    marked.push(...midA.map((token) => ({ kind: "removed" as const, token })), ...midB.map((token) => ({ kind: "added" as const, token })));
  } else {
    let i = 0;
    let j = 0;
    for (const [keepA, keepB] of [...common(midA, midB, (x, y) => x === y), [midA.length, midB.length] as [number, number]]) {
      marked.push(...midA.slice(i, keepA).map((token) => ({ kind: "removed" as const, token })));
      marked.push(...midB.slice(j, keepB).map((token) => ({ kind: "added" as const, token })));
      if (keepA < midA.length) {
        marked.push({ kind: "same", token: midA[keepA] as string });
      }
      i = keepA + 1;
      j = keepB + 1;
    }
  }
  marked.push(...a.slice(a.length - end).map((token) => ({ kind: "same" as const, token })));
  return runs(marked);
}

/** A bullet list as lines: each bullet on its own, and each sub-bullet under it marked as one. */
export function bulletText(bullets: readonly Bullet[] | undefined): string {
  return (bullets ?? []).flatMap((one) => (typeof one === "string" ? [one] : [one.text, ...(one.bullets ?? []).map((child) => `– ${child}`)])).join(LINE);
}

const LAYOUT_NAMES: Record<DeckSlide["layout"], string> = {
  HMCTS_SECTION: "Section",
  HMCTS_CONTENT: "Content",
  HMCTS_TWO_COLUMN: "Two columns",
  HMCTS_IMAGE: "Picture",
  HMCTS_CLOSING: "Closing"
};

type Fields = Partial<Record<FieldName, string>>;

/** What a slide says, field by field, as the words compared. */
function slideFields(slide: DeckSlide): { fields: Fields; asset?: string } {
  const fields: Fields = { title: slide.title, layout: LAYOUT_NAMES[slide.layout], notes: slide.notes };
  switch (slide.layout) {
    case "HMCTS_CONTENT":
      return { fields: { ...fields, bullets: bulletText(slide.bullets) } };
    case "HMCTS_TWO_COLUMN":
      return { fields: { ...fields, left: bulletText(slide.left), right: bulletText(slide.right) } };
    case "HMCTS_IMAGE":
      return {
        fields: { ...fields, picture: slide.image.decorative === true ? "Decorative picture" : (slide.image.alt ?? ""), caption: slide.caption },
        asset: slide.image.asset
      };
    case "HMCTS_CLOSING":
      return { fields: { ...fields, subtitle: slide.subtitle } };
    default:
      return { fields };
  }
}

const FIELD_ORDER: readonly [FieldName, string][] = [
  ["layout", "Layout"],
  ["title", "Title"],
  ["subtitle", "Subtitle"],
  ["bullets", "Bullets"],
  ["left", "Left column"],
  ["right", "Right column"],
  ["picture", "Picture"],
  ["caption", "Caption"],
  ["notes", "Speaker notes"]
];

function fieldChanges(before: Fields, after: Fields): FieldChange[] {
  return FIELD_ORDER.flatMap(([field, label]) => {
    const was = before[field] ?? "";
    const now = after[field] ?? "";
    return was === now ? [] : [{ field, label, parts: diffWords(was, now) }];
  });
}

function slideChanges(before: DeckSlide, after: DeckSlide): FieldChange[] {
  const was = slideFields(before);
  const now = slideFields(after);
  const changes = fieldChanges(was.fields, now.fields);
  if (was.asset !== undefined && now.asset !== undefined && was.asset !== now.asset) {
    const picture = changes.find((change) => change.field === "picture");
    const note = "The picture itself was replaced.";
    if (picture === undefined) {
      const at = changes.findIndex(
        (change) => FIELD_ORDER.findIndex(([name]) => name === change.field) > FIELD_ORDER.findIndex(([name]) => name === "picture")
      );
      const entry: FieldChange = { field: "picture", label: "Picture", parts: diffWords(now.fields.picture ?? "", now.fields.picture ?? ""), note };
      changes.splice(at === -1 ? changes.length : at, 0, entry);
    } else {
      picture.note = note;
    }
  }
  return changes;
}

const keyOf = (slide: DeckSlide, index: number, side: "a" | "b"): string => slide.id ?? `#${side}${index}`;

/** `after` against `before`: the title slide's fields, and every slide added, removed, moved or changed. */
export function diffDecks(before: DeckOutline, after: DeckOutline): DeckDiff {
  const deck = fieldChanges(
    { title: before.title, subtitle: before.subtitle, notes: before.notes },
    { title: after.title, subtitle: after.subtitle, notes: after.notes }
  );
  const older = before.slides.map((slide, index) => ({ key: keyOf(slide, index, "a"), place: { index, slide } }));
  const newer = after.slides.map((slide, index) => ({ key: keyOf(slide, index, "b"), place: { index, slide } }));
  const olderByKey = new Map(older.map((one) => [one.key, one.place]));
  const newerKeys = new Set(newer.map((one) => one.key));
  // A slide has moved when it is out of order against the others both versions have, not merely shifted along by one
  // added or removed before it: the longest run kept in order stays put, and the rest moved.
  const keptOlder = older.filter((one) => newerKeys.has(one.key)).map((one) => one.key);
  const keptNewer = newer.filter((one) => olderByKey.has(one.key)).map((one) => one.key);
  const inOrder = new Set(common(keptOlder, keptNewer, (x, y) => x === y).map(([i]) => keptOlder[i] as string));

  const entries: SlideDiff[] = newer.map(({ key, place }) => {
    const was = olderByKey.get(key);
    if (was === undefined) {
      return { id: key, status: "added", moved: false, after: place, fields: [] };
    }
    const fields = slideChanges(was.slide, place.slide);
    const moved = !inOrder.has(key);
    const status: SlideStatus = fields.length > 0 ? "changed" : moved ? "moved" : "same";
    return { id: key, status, moved, before: was, after: place, fields };
  });
  // Each removed slide goes after the entry for the slide it followed in the older version, or first when none did.
  older.forEach(({ key, place }, index) => {
    if (newerKeys.has(key)) {
      return;
    }
    const removed: SlideDiff = { id: key, status: "removed", moved: false, before: place, fields: [] };
    const previous = older
      .slice(0, index)
      .map((one) => one.key)
      .filter((one) => entries.some((entry) => entry.id === one))
      .at(-1);
    const at = previous === undefined ? -1 : entries.findIndex((entry) => entry.id === previous);
    entries.splice(at + 1, 0, removed);
  });
  const count = (status: SlideStatus) => entries.filter((entry) => entry.status === status).length;
  return {
    deck,
    slides: entries,
    counts: { added: count("added"), removed: count("removed"), moved: entries.filter((entry) => entry.moved).length, changed: count("changed") }
  };
}

/** The diff in one sentence, for the compare view's heading and the announcer. */
export function diffSummary(diff: DeckDiff): string {
  const { added, removed, moved, changed } = diff.counts;
  const said = [
    [changed, "changed"],
    [added, "added"],
    [removed, "removed"],
    [moved, "moved"]
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, what]) => `${n} ${n === 1 ? "slide" : "slides"} ${what}`);
  const title = diff.deck.length > 0 ? ["the title slide changed"] : [];
  const all = [...title, ...said];
  if (all.length === 0) {
    return "No differences";
  }
  const sentence = all.length === 1 ? (all[0] as string) : `${all.slice(0, -1).join(", ")} and ${all.at(-1)}`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
