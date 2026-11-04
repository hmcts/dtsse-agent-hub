"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DeckSnapshot, SaveDeckResult } from "@/app/_actions/decks";
import { type DeckOutline, type DeckSlide, jsonbText, plannable } from "@/assistant/deck";
import type { DeckView } from "@/assistant/deck-store";
import { type PlannedSlide, plan } from "@/assistant/slides/masters";
import {
  blankSlide,
  blockingProblem,
  canIndent,
  canOutdent,
  changeLayout,
  type EditBullet,
  type FieldWarning,
  fieldHint,
  flatBullets,
  freshId,
  insertAfter,
  LAYOUTS,
  type Layout,
  layoutLabel,
  layoutsFor,
  moveSlide,
  nestBullets,
  removeAt,
  setLevel,
  setText,
  slideWarnings
} from "@/components/assistant/deck-editing";
import { SlideCanvas, slideTitle } from "@/components/assistant/SlideCanvas";
import type { ActionResult } from "@/web/action";

export type SaveDeckAction = (input: {
  conversationId: unknown;
  outline: unknown;
  baseVersion: unknown;
  baseRevision: unknown;
}) => Promise<ActionResult<SaveDeckResult>>;

/** The version and revision an edit was made from, which a save names so a newer one refuses it. */
export interface DeckBase {
  version: number;
  revision: number;
}

/**
 * An edit the editor was closed on that did not save: its save failed, found a newer version, could not be made
 * because the outline had a gap in it, or was waiting on the person's choice between it and a newer version. Handed
 * to the page, which opens the slides again with it, and with the choice still to make, rather than lose it.
 */
export interface UnsavedDeckDraft {
  outline: DeckOutline;
  base: DeckBase;
  conflict: DeckSnapshot | null;
}

/** A pause in editing this long saves the deck, as it does the document. */
export const SAVE_AFTER_MS = 1000;

type SaveState = "saved" | "saving" | "unsaved" | "failed" | "invalid";

const button = "flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg border border-asst-strong px-2.5 text-[13px] hover:bg-asst-field disabled:opacity-40";
const small = "h-[26px] shrink-0 rounded-md border border-asst-strong px-2 text-[12px] hover:bg-asst-field disabled:opacity-40";
const box = "rounded-lg border border-asst-strong bg-asst-field px-2.5 py-1.5 text-[13px] text-asst-text";
const field = `w-full ${box}`;
const labelClass = "text-[13px] font-medium text-asst-text";

const backgroundSrc = (image: string): string => `/assistant/slides/${image}`;

function assetUrl(conversationId: string, sha256: string): string {
  return `/api/ui/assistant/decks/${encodeURIComponent(conversationId)}/assets/${sha256}`;
}

const same = (a: DeckOutline | null, b: DeckOutline | null): boolean => jsonbText(a) === jsonbText(b);

type Bullet = string | { text: string; bullets?: string[] };

async function settled(saving: Promise<ActionResult<SaveDeckResult>>): Promise<ActionResult<SaveDeckResult>> {
  try {
    return await saving;
  } catch {
    return { ok: false, error: "could not save" };
  }
}

function snapshotOf(deck: DeckView): DeckSnapshot {
  return { title: deck.title, outline: deck.outline, version: deck.version, revision: deck.revision ?? 0, updatedBy: deck.updatedBy };
}

/** Text a person typed into an optional field: left out of the outline when it is empty, as the plugin expects. */
function optional<T extends object, K extends string>(target: T, key: K, value: string): T {
  const { [key]: _gone, ...rest } = target as Record<string, unknown>;
  return (value.trim() === "" ? rest : { ...rest, [key]: value }) as T;
}

/** A field's warnings from the plugin's checks, under it: they never stop a save. */
function Warnings({ id, warnings }: { id: string; warnings: readonly FieldWarning[] }) {
  if (warnings.length === 0) {
    return null;
  }
  return (
    <ul id={id} className="flex flex-col gap-0.5 text-[12px] text-asst-warn">
      {warnings.map((warning) => (
        <li key={`${warning.item ?? "all"}-${warning.message}`}>
          <span aria-hidden="true">⚠ </span>
          {warning.message}
        </li>
      ))}
    </ul>
  );
}

function TextField({
  label,
  value,
  onChange,
  hint,
  warnings = [],
  multiline = false,
  focusKey
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  warnings?: readonly FieldWarning[];
  multiline?: boolean;
  focusKey?: string;
}) {
  const id = useId();
  const described = [hint === undefined ? null : `${id}-hint`, warnings.length === 0 ? null : `${id}-warn`].filter((one) => one !== null).join(" ");
  const common = {
    id,
    value,
    "data-focus": focusKey,
    "aria-describedby": described === "" ? undefined : described,
    className: field
  };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-[12px] text-asst-muted">
          {hint}
        </p>
      )}
      {multiline ? (
        <textarea {...common} rows={3} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input {...common} type="text" onChange={(event) => onChange(event.target.value)} />
      )}
      <Warnings id={`${id}-warn`} warnings={warnings} />
    </div>
  );
}

/**
 * One list of bullets: a labelled text box for each, with buttons to indent, outdent and remove it, and one to add a
 * bullet at the end; Enter in a box adds one after it. Every button is named for the bullet it acts on.
 */
function BulletList({
  label,
  field: name,
  items,
  onChange,
  warnings,
  hint
}: {
  label: string;
  /** The outline field, which the focus keys and the warnings are matched by. */
  field: string;
  items: readonly EditBullet[];
  /** `said` is announced and `focusKey` focused once it renders; both empty for typing. */
  onChange: (items: EditBullet[], said: string, focusKey: string) => void;
  warnings: readonly FieldWarning[];
  hint?: string;
}) {
  const id = useId();
  // In a two-column slide the column is part of every name, so "Indent bullet 2" is never ambiguous.
  const of = name === "bullets" ? "" : ` in the ${label.toLowerCase()}`;
  const whole = warnings.filter((warning) => warning.item === undefined);
  return (
    <fieldset className="flex flex-col gap-1.5 rounded-lg border border-asst-line px-3 pb-3 pt-1.5">
      <legend className={`${labelClass} px-1`}>{label}</legend>
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-[12px] text-asst-muted">
          {hint}
        </p>
      )}
      <ol className="flex flex-col gap-1.5">
        {items.map((item, index) => {
          const n = index + 1;
          const inputId = `${id}-${index}`;
          const own = warnings.filter((warning) => warning.item === index);
          return (
            <li key={index} className={`flex flex-col gap-1 ${item.level === 1 ? "ml-6" : ""}`}>
              <label htmlFor={inputId} className="text-[12px] text-asst-muted">
                {item.level === 1 ? `Bullet ${n}, nested` : `Bullet ${n}`}
              </label>
              <div className="flex flex-wrap items-center gap-1">
                <input
                  id={inputId}
                  type="text"
                  value={item.text}
                  data-focus={`bullet-${name}-${index}`}
                  aria-describedby={own.length === 0 ? undefined : `${inputId}-warn`}
                  onChange={(event) => onChange(setText(items, index, event.target.value), "", "")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      onChange(insertAfter(items, index), `Bullet ${n + 1} added${of}`, `bullet-${name}-${index + 1}`);
                    }
                  }}
                  className={`${box} min-w-[8rem] flex-1`}
                />
                <button
                  type="button"
                  disabled={!canIndent(items, index)}
                  onClick={() => onChange(setLevel(items, index, 1), `Bullet ${n} indented${of}`, `bullet-${name}-${index}`)}
                  aria-label={`Indent bullet ${n}${of}`}
                  className={small}
                >
                  Indent
                </button>
                <button
                  type="button"
                  disabled={!canOutdent(items, index)}
                  onClick={() => onChange(setLevel(items, index, 0), `Bullet ${n} outdented${of}`, `bullet-${name}-${index}`)}
                  aria-label={`Outdent bullet ${n}${of}`}
                  className={small}
                >
                  Outdent
                </button>
                <button
                  type="button"
                  disabled={items.length === 1}
                  onClick={() => onChange(removeAt(items, index), `Bullet ${n} removed${of}`, `bullet-${name}-${Math.max(0, index - 1)}`)}
                  aria-label={`Remove bullet ${n}${of}`}
                  className={small}
                >
                  Remove
                </button>
              </div>
              <Warnings id={`${inputId}-warn`} warnings={own} />
            </li>
          );
        })}
      </ol>
      <Warnings id={`${id}-warn`} warnings={whole} />
      <div>
        <button
          type="button"
          onClick={() => onChange(insertAfter(items, items.length - 1, 0), `Bullet ${items.length + 1} added${of}`, `bullet-${name}-${items.length}`)}
          aria-label={`Add bullet${of}`}
          className={small}
        >
          Add bullet
        </button>
      </div>
    </fieldset>
  );
}

/** The current slide's fields, by its layout. Slide 0 is the title slide, made from the outline's own fields. */
function SlideFields({
  outline,
  at,
  onOutline,
  onSlide,
  warnings
}: {
  outline: DeckOutline;
  at: number;
  onOutline: (next: DeckOutline) => void;
  onSlide: (next: DeckSlide, said?: string, focusKey?: string) => void;
  warnings: readonly FieldWarning[];
}) {
  const of = (name: string) => warnings.filter((warning) => warning.field === name);
  if (at === 0) {
    return (
      <>
        <TextField
          label="Deck title"
          value={outline.title}
          onChange={(title) => onOutline({ ...outline, title })}
          hint={fieldHint("HMCTS_TITLE", "title")}
          warnings={of("title")}
          focusKey="title"
        />
        <TextField
          label="Subtitle (optional)"
          value={outline.subtitle ?? ""}
          onChange={(subtitle) => onOutline(optional(outline, "subtitle", subtitle))}
          hint={fieldHint("HMCTS_TITLE", "subtitle")}
          warnings={of("subtitle")}
        />
        <TextField label="Speaker notes (optional)" value={outline.notes ?? ""} onChange={(notes) => onOutline(optional(outline, "notes", notes))} multiline />
      </>
    );
  }
  const slide = outline.slides[at - 1] as DeckSlide;
  const bullets = (name: "bullets" | "left" | "right", label: string, value: Bullet[]) => (
    <BulletList
      label={label}
      field={name}
      items={flatBullets(value)}
      hint={fieldHint(slide.layout, name)}
      warnings={of(name)}
      onChange={(items, said, focusKey) => {
        onSlide({ ...slide, [name]: nestBullets(items) } as DeckSlide, said === "" ? undefined : said, focusKey === "" ? undefined : focusKey);
      }}
    />
  );
  return (
    <>
      <TextField
        label="Title"
        value={slide.title}
        onChange={(title) => onSlide({ ...slide, title })}
        hint={fieldHint(slide.layout, "title")}
        warnings={of("title")}
        focusKey="title"
      />
      {slide.layout === "HMCTS_CONTENT" ? bullets("bullets", "Bullets", slide.bullets) : null}
      {slide.layout === "HMCTS_TWO_COLUMN" ? (
        <>
          {bullets("left", "Left column", slide.left)}
          {bullets("right", "Right column", slide.right)}
        </>
      ) : null}
      {slide.layout === "HMCTS_IMAGE" ? (
        <>
          <fieldset className="flex flex-col gap-2 rounded-lg border border-asst-line px-3 pb-3 pt-1.5">
            <legend className={`${labelClass} px-1`}>Picture</legend>
            <label className="flex items-center gap-2 text-[13px] text-asst-body">
              <input
                type="checkbox"
                checked={slide.image.decorative === true}
                onChange={(event) => {
                  const { asset } = slide.image;
                  const alt = slide.image.alt ?? "";
                  onSlide({
                    ...slide,
                    image: event.target.checked ? { asset, decorative: true, ...(alt.trim() === "" ? {} : { alt }) } : { asset, alt }
                  });
                }}
              />
              Decorative: the picture adds nothing, so it has no alt text
            </label>
            {slide.image.decorative === true ? null : (
              <TextField
                label="Alt text"
                value={slide.image.alt ?? ""}
                onChange={(alt) => onSlide({ ...slide, image: { asset: slide.image.asset, alt } })}
                hint="Say what the picture shows and why it is there."
                warnings={of("image")}
                multiline
              />
            )}
            <div>
              <button
                type="button"
                onClick={() => onSlide(changeLayout(slide, "HMCTS_CONTENT").slide, "Picture removed. The slide is now a Content slide", "bullet-bullets-0")}
                className={small}
              >
                Remove picture
              </button>
            </div>
          </fieldset>
          <TextField
            label="Caption (optional)"
            value={slide.caption ?? ""}
            onChange={(caption) => onSlide(optional(slide, "caption", caption))}
            hint={fieldHint(slide.layout, "caption")}
            warnings={of("caption")}
          />
        </>
      ) : null}
      {slide.layout === "HMCTS_CLOSING" ? (
        <TextField
          label="Subtitle (optional)"
          value={slide.subtitle ?? ""}
          onChange={(subtitle) => onSlide(optional(slide, "subtitle", subtitle))}
          hint={fieldHint(slide.layout, "subtitle")}
          warnings={of("subtitle")}
        />
      ) : null}
      <TextField label="Speaker notes (optional)" value={slide.notes ?? ""} onChange={(notes) => onSlide(optional(slide, "notes", notes))} multiline />
    </>
  );
}

/**
 * The deck's latest version as a form, beside a live drawing of the slide being edited: every field of every layout,
 * the plugin's limits and warnings under each, and the slide operations. It saves itself after each pause, and as it
 * closes, through `save`, the way the document panel does: an edit that does not land then comes back to the page
 * through `onUnsaved`. A newer version from the assistant, or from another tab, is taken in at once unless the person
 * has unsaved changes, when they choose between it and theirs.
 */
export function DeckEditor({
  conversationId,
  deck,
  save,
  announce,
  onDone,
  onBusy,
  draft,
  onUnsaved,
  narrow = false
}: {
  conversationId: string;
  deck: DeckView;
  save: SaveDeckAction;
  /** Says what each operation did, through the page's one announcer. */
  announce: (text: string) => void;
  /** Leaves edit mode; the editor's own close saves what is left. */
  onDone: () => void;
  /** Told whether the person has edits not yet saved, or a conflict to settle, which taking the panel away would cut short. */
  onBusy?: (busy: boolean) => void;
  /** An edit a closed editor could not save, to open with in place of the latest version. Read as the editor mounts. */
  draft?: UnsavedDeckDraft;
  onUnsaved?: (draft: UnsavedDeckDraft) => void;
  narrow?: boolean;
}) {
  const [outline, setOutline] = useState<DeckOutline>(draft?.outline ?? deck.outline);
  const [base, setBase] = useState<DeckBase>(draft?.base ?? { version: deck.version, revision: deck.revision ?? 0 });
  const [state, setState] = useState<SaveState>(() => {
    if (draft === undefined) {
      return "saved";
    }
    return blockingProblem(draft.outline) !== null ? "invalid" : draft.conflict === null ? "failed" : "unsaved";
  });
  const [conflict, setConflict] = useState<DeckSnapshot | null>(draft?.conflict ?? null);
  const [chosen, setChosen] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [addLayout, setAddLayout] = useState<Exclude<Layout, "HMCTS_IMAGE">>("HMCTS_CONTENT");
  const [nextLayout, setNextLayout] = useState<Layout | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const focusing = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const baseNow = useRef(base);
  baseNow.current = base;
  const outlineNow = useRef(outline);
  outlineNow.current = outline;
  const inFlight = useRef(false);
  const queued = useRef(false);
  const mounted = useRef(true);
  const discarded = useRef(false);
  const problem = useMemo(() => blockingProblem(outline), [outline]);
  // A save in flight counts: an update arriving before its reply would otherwise replace what is being saved.
  const dirty = state === "unsaved" || state === "failed" || state === "saving" || state === "invalid";
  const busy = dirty || conflict !== null;
  const unsaved = useRef<UnsavedDeckDraft | null>(null);
  // An edit waiting on the choice between it and a newer version is not saved as the editor closes, which the newer
  // version would refuse, but handed back with that version so the choice is offered again.
  unsaved.current =
    conflict !== null
      ? { outline, base, conflict }
      : state === "unsaved" || state === "failed" || state === "invalid"
        ? { outline, base, conflict: null }
        : null;
  const closing = useRef({ conversationId, save, onBusy, onUnsaved });
  closing.current = { conversationId, save, onBusy, onUnsaved };

  const total = outline.slides.length + 1;
  const at = Math.min(chosen, total - 1);
  const slide = at === 0 ? undefined : outline.slides[at - 1];

  const drawn = useMemo(() => {
    const src = (sha: string) => assetUrl(conversationId, sha);
    const sizes = Object.fromEntries(Object.entries(deck.sizes).map(([sha, size]) => [src(sha), size]));
    const planned = plannable(outline, src);
    return { slides: plan(planned), sizes, plannable: planned };
  }, [conversationId, outline, deck.sizes]);
  const warnings = useMemo(() => slideWarnings(drawn.plannable, at), [drawn.plannable, at]);

  useEffect(() => closing.current.onBusy?.(busy), [busy]);

  // Focus goes where the last operation said, once the render that made the element there has committed.
  useLayoutEffect(() => {
    const key = focusing.current;
    if (key === null) {
      return;
    }
    focusing.current = null;
    const target = root.current?.querySelector<HTMLElement>(`[data-focus="${key}"]`);
    if (target !== null && target !== undefined && !(target as HTMLButtonElement).disabled) {
      target.focus();
    }
  });
  const focus = (key: string) => {
    focusing.current = key;
  };

  async function persist(next: DeckOutline): Promise<void> {
    if (blockingProblem(next) !== null) {
      setState("invalid");
      return;
    }
    if (inFlight.current) {
      queued.current = true;
      return;
    }
    inFlight.current = true;
    setState("saving");
    const from = baseNow.current;
    const result = await settled(closing.current.save({ conversationId, outline: next, baseVersion: from.version, baseRevision: from.revision }));
    inFlight.current = false;
    if (!mounted.current) {
      settleAfterClose(next, from, result);
      return;
    }
    if (!result.ok) {
      setState("failed");
      return;
    }
    if (!result.saved) {
      queued.current = false;
      setState("unsaved");
      setConflict(result.current);
      return;
    }
    const moved = { version: result.version, revision: result.revision };
    baseNow.current = moved;
    setBase(moved);
    if (queued.current || !same(outlineNow.current, next)) {
      queued.current = false;
      void persist(outlineNow.current);
      return;
    }
    setState("saved");
    setConflict(null);
  }

  /**
   * A save that was in flight as the editor closed, which the close left to finish: the page is all that is left to
   * keep an edit that did not land, and an edit made while it was in flight still has to be saved on top of it.
   */
  function settleAfterClose(next: DeckOutline, from: DeckBase, result: ActionResult<SaveDeckResult>): void {
    const latest = outlineNow.current;
    const { onUnsaved: lost, save: saveNow } = closing.current;
    if (!(result.ok && result.saved)) {
      if (!discarded.current) {
        lost?.({ outline: latest, base: from, conflict: result.ok && !result.saved ? result.current : null });
      }
      return;
    }
    if (discarded.current || same(latest, next)) {
      return;
    }
    const moved = { version: result.version, revision: result.revision };
    if (blockingProblem(latest) !== null) {
      lost?.({ outline: latest, base: moved, conflict: null });
      return;
    }
    void settled(saveNow({ conversationId, outline: latest, baseVersion: moved.version, baseRevision: moved.revision })).then((again) => {
      if (!(again.ok && again.saved)) {
        lost?.({ outline: latest, base: moved, conflict: again.ok && !again.saved ? again.current : null });
      }
    });
  }

  function edited(next: DeckOutline): void {
    setOutline(next);
    outlineNow.current = next;
    setState(blockingProblem(next) === null ? "unsaved" : "invalid");
    setLeaving(false);
    if (timer.current !== null) {
      clearTimeout(timer.current);
    }
    if (conflict === null) {
      timer.current = setTimeout(() => void persist(outlineNow.current), SAVE_AFTER_MS);
    }
  }

  // The assistant, or this person in another tab, saved a newer version or revision.
  useEffect(() => {
    if (inFlight.current) {
      return;
    }
    const revision = deck.revision ?? 0;
    if (deck.version < base.version || (deck.version === base.version && revision <= base.revision)) {
      return;
    }
    if (dirty && !same(deck.outline, outline)) {
      setConflict(snapshotOf(deck));
      return;
    }
    setOutline(deck.outline);
    setBase({ version: deck.version, revision });
    setState("saved");
    setConflict(null);
  }, [deck, base, dirty, outline]);

  // Closing, by Done, by the person or by the page, saves the edit the pause would have.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
      const pending = unsaved.current;
      const { conversationId: id, save: saveNow, onBusy: told, onUnsaved: lost } = closing.current;
      if (pending !== null && !discarded.current && !inFlight.current) {
        if (pending.conflict !== null || blockingProblem(pending.outline) !== null) {
          lost?.(pending);
        } else {
          void settled(saveNow({ conversationId: id, outline: pending.outline, baseVersion: pending.base.version, baseRevision: pending.base.revision })).then(
            (result) => {
              if (!(result.ok && result.saved)) {
                lost?.({ ...pending, conflict: result.ok && !result.saved ? result.current : null });
              }
            }
          );
        }
      }
      told?.(false);
    };
  }, []);

  function go(index: number, focusRail = false): void {
    const next = Math.max(0, Math.min(total - 1, index));
    if (next === at) {
      return;
    }
    setChosen(next);
    setConfirming(false);
    setNextLayout(null);
    if (focusRail) {
      focus(`rail-${next}`);
    }
    announce(`Slide ${next + 1} of ${total}: ${slideTitle(drawn.slides[next] as PlannedSlide)}`);
  }

  function updateSlide(next: DeckSlide, said?: string, focusKey?: string): void {
    edited({ ...outline, slides: outline.slides.map((one, index) => (index === at - 1 ? next : one)) });
    if (said !== undefined && said !== "") {
      announce(said);
    }
    if (focusKey !== undefined) {
      focus(focusKey);
    }
  }

  function addSlide(): void {
    const added = blankSlide(addLayout, freshId(outline.slides));
    // After the current slide: the title slide is 0 here, so the current slide is the outline's `at - 1`.
    const where = at;
    edited({ ...outline, slides: [...outline.slides.slice(0, where), added, ...outline.slides.slice(where)] });
    setChosen(where + 1);
    setNextLayout(null);
    focus("title");
    announce(`${layoutLabel(addLayout)} slide added as slide ${where + 2} of ${total + 1}`);
  }

  function duplicate(): void {
    if (slide === undefined) {
      return;
    }
    const copy = { ...structuredClone(slide), id: freshId(outline.slides) };
    edited({ ...outline, slides: [...outline.slides.slice(0, at), copy, ...outline.slides.slice(at)] });
    setChosen(at + 1);
    focus("title");
    announce(`Slide ${at + 1} duplicated as slide ${at + 2}`);
  }

  function remove(): void {
    if (slide === undefined) {
      return;
    }
    const slides = outline.slides.filter((_, index) => index !== at - 1);
    edited({ ...outline, slides });
    const next = Math.min(at, slides.length);
    setChosen(next);
    setConfirming(false);
    focus(`rail-${next}`);
    announce(`Slide ${at + 1} deleted. Showing slide ${next + 1} of ${slides.length + 1}`);
  }

  function move(to: number, how: "button" | "drag", from = at): void {
    if (from < 1 || to < 1 || to > outline.slides.length) {
      return;
    }
    edited({ ...outline, slides: moveSlide(outline.slides, from - 1, to - 1) });
    setChosen(to);
    if (how === "button") {
      const up = to < from;
      // The button pressed keeps focus while it can still move the slide that way; at the end, the other one takes it.
      focus(up ? (to > 1 ? "move-up" : "move-down") : to < outline.slides.length ? "move-down" : "move-up");
    }
    announce(`Slide moved to position ${to + 1} of ${total}`);
  }

  function applyLayout(layout: Layout): void {
    if (slide === undefined) {
      return;
    }
    updateSlide(changeLayout(slide, layout).slide, `Layout changed to ${layoutLabel(layout)}`, "title");
    setNextLayout(null);
  }

  function takeTheirs(current: DeckSnapshot): void {
    if (current.outline !== null) {
      setOutline(current.outline);
      outlineNow.current = current.outline;
    }
    const moved = { version: current.version, revision: current.revision };
    baseNow.current = moved;
    setBase(moved);
    setConflict(null);
    setChoosing(false);
    setState("saved");
    announce(`Showing version ${current.version}`);
  }

  function keepMine(current: DeckSnapshot): void {
    const moved = { version: current.version, revision: current.revision };
    baseNow.current = moved;
    setBase(moved);
    setConflict(null);
    setChoosing(false);
    void persist(outlineNow.current);
  }

  function done(): void {
    if (conflict !== null) {
      setChoosing(true);
      focus("keep-mine");
      announce("Choose Use theirs or Keep mine before you finish editing");
      return;
    }
    if (problem !== null && state === "invalid") {
      setLeaving(true);
      return;
    }
    onDone();
  }

  function onRailKey(event: React.KeyboardEvent<HTMLButtonElement>): void {
    const moves: Record<string, number> = { ArrowUp: at - 1, ArrowDown: at + 1, Home: 0, End: total - 1 };
    const target = moves[event.key];
    if (target !== undefined) {
      event.preventDefault();
      go(target, true);
    }
  }

  const saveLabel = {
    saved: "Saved",
    saving: "Saving…",
    unsaved: "Not saved yet",
    failed: "Could not save",
    invalid: `Not saved: ${problem?.message ?? ""}`
  }[state];
  const planned = drawn.slides[at] as PlannedSlide;
  const choices = slide === undefined ? [] : layoutsFor(slide).filter((one) => one.layout !== slide.layout);
  const preview = slide !== undefined && nextLayout !== null ? changeLayout(slide, nextLayout) : null;

  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col">
      <div role="toolbar" aria-label="Editing slides" className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-asst-field px-3 py-1.5">
        <button type="button" onClick={done} className={`${button} border-asst-accent font-semibold`}>
          Done
        </button>
        <span
          role="status"
          className={`min-w-0 text-xs ${state === "failed" || state === "invalid" ? "text-asst-error" : state === "saved" ? "text-asst-ok" : "text-asst-faint"}`}
        >
          {saveLabel}
        </span>
        {state === "failed" ? (
          <button type="button" onClick={() => void persist(outline)} className={button}>
            Try again
          </button>
        ) : null}
        <span className="ml-auto text-xs text-asst-faint">Editing version {base.version}</span>
      </div>
      {conflict === null ? null : (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-asst-field bg-asst-raised px-4 py-2.5 text-[13px]">
          <span className="min-w-0 flex-1">
            {conflict.updatedBy === "agent" ? "The assistant has changed these slides." : "These slides were changed somewhere else."} Use that version, or keep
            yours?{choosing ? " Choose one before you finish editing." : ""}
          </span>
          <button type="button" onClick={() => takeTheirs(conflict)} className="rounded-lg border border-asst-strong px-3 py-1 hover:bg-asst-active">
            Use theirs
          </button>
          <button
            type="button"
            data-focus="keep-mine"
            onClick={() => keepMine(conflict)}
            className="rounded-lg bg-asst-accent px-3 py-1 font-semibold text-asst-ink hover:bg-asst-accent-hover"
          >
            Keep mine
          </button>
        </div>
      )}
      {leaving && problem !== null ? (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-asst-field bg-asst-raised px-4 py-2.5 text-[13px]">
          <span className="min-w-0 flex-1">{problem.message}, so your changes cannot be saved. Fix it, or discard your changes.</span>
          <button
            type="button"
            onClick={() => {
              setLeaving(false);
              go(problem.slide);
            }}
            className="rounded-lg border border-asst-strong px-3 py-1 hover:bg-asst-active"
          >
            Keep editing
          </button>
          <button
            type="button"
            onClick={() => {
              discarded.current = true;
              onDone();
            }}
            className="rounded-lg border border-asst-strong px-3 py-1 hover:bg-asst-active"
          >
            Discard changes
          </button>
        </div>
      ) : null}
      <div className={`flex min-h-0 flex-1 ${narrow ? "flex-col" : ""}`}>
        <ol
          aria-label="Slides"
          className={
            narrow
              ? "flex shrink-0 gap-2 overflow-x-auto border-b border-asst-field p-2"
              : "flex w-[118px] shrink-0 flex-col gap-2 overflow-y-auto border-r border-asst-field p-2"
          }
        >
          {drawn.slides.map((one, index) => (
            <li
              key={one.id ?? `slide-${index}`}
              className={narrow ? "w-[96px] shrink-0" : ""}
              draggable={index > 0}
              onDragStart={(event) => {
                setDragging(index);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => {
                if (dragging !== null && index > 0) {
                  event.preventDefault();
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging !== null && dragging !== index) {
                  move(index, "drag", dragging);
                }
                setDragging(null);
              }}
              onDragEnd={() => setDragging(null)}
            >
              <button
                type="button"
                data-focus={`rail-${index}`}
                tabIndex={index === at ? 0 : -1}
                aria-current={index === at ? "true" : undefined}
                onClick={() => go(index)}
                onKeyDown={onRailKey}
                className={`flex w-full flex-col gap-1 rounded-md p-1 text-left ${index === at ? "bg-asst-active outline-2 outline-asst-accent" : "hover:bg-asst-field"}`}
              >
                <span aria-hidden="true" className="text-[11px] text-asst-muted">
                  {index + 1}
                </span>
                <span className="sr-only">{`Slide ${index + 1}: ${slideTitle(one)}`}</span>
                <span aria-hidden="true" className="pointer-events-none block w-full rounded-sm border border-asst-line">
                  <SlideCanvas slide={one} index={index} total={total} backgroundSrc={backgroundSrc} sizes={drawn.sizes} thumbnail />
                </span>
              </button>
            </li>
          ))}
        </ol>
        <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
          <h3 className="text-[15px] font-semibold text-asst-text">
            <span className="text-asst-muted">Slide {at + 1}: </span>
            {at === 0 ? "Title slide" : `${layoutLabel(slide?.layout ?? "")} slide`}
          </h3>
          {slide === undefined ? null : (
            <div role="group" aria-label={`Slide ${at + 1}`} className="flex flex-wrap items-center gap-1.5">
              <button type="button" data-focus="move-up" disabled={at <= 1} onClick={() => move(at - 1, "button")} className={button}>
                Move up
              </button>
              <button type="button" data-focus="move-down" disabled={at >= outline.slides.length} onClick={() => move(at + 1, "button")} className={button}>
                Move down
              </button>
              <button type="button" onClick={duplicate} className={button}>
                Duplicate
              </button>
              <button
                type="button"
                data-focus="delete"
                disabled={outline.slides.length === 1}
                onClick={() => {
                  setConfirming(true);
                  focus("confirm-delete");
                }}
                className={button}
              >
                Delete
              </button>
            </div>
          )}
          {confirming && slide !== undefined ? (
            <div
              role="alertdialog"
              aria-label="Delete slide"
              className="flex flex-wrap items-center gap-2 rounded-lg border border-asst-strong bg-asst-raised px-3 py-2 text-[13px]"
            >
              <span className="min-w-0 flex-1">
                Delete slide {at + 1}, “{slide.title}”? You can get it back from the history.
              </span>
              <button type="button" data-focus="confirm-delete" onClick={remove} className={`${button} border-asst-error text-asst-error`}>
                Delete slide
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  focus("delete");
                }}
                className={button}
              >
                Cancel
              </button>
            </div>
          ) : null}
          <div className="rounded-md border border-asst-line">
            <SlideCanvas slide={planned} index={at} total={total} backgroundSrc={backgroundSrc} sizes={drawn.sizes} headingLevel={4} />
          </div>
          <form method="post" className="flex flex-col gap-3" onSubmit={(event) => event.preventDefault()} aria-label={`Slide ${at + 1} fields`}>
            <SlideFields outline={outline} at={at} onOutline={edited} onSlide={updateSlide} warnings={warnings} />
          </form>
          {slide === undefined || choices.length === 0 ? null : (
            <LayoutChange
              current={slide.layout}
              choices={choices}
              chosen={nextLayout}
              onChoose={setNextLayout}
              lost={preview?.lost ?? []}
              onApply={() => nextLayout !== null && applyLayout(nextLayout)}
            />
          )}
          <div className="flex flex-wrap items-end gap-2 border-t border-asst-field pt-3">
            <AddSlide layout={addLayout} onLayout={setAddLayout} onAdd={addSlide} after={at + 1} />
          </div>
        </div>
      </div>
    </div>
  );
}

function LayoutChange({
  current,
  choices,
  chosen,
  onChoose,
  lost,
  onApply
}: {
  current: Layout;
  choices: readonly { layout: Layout; label: string }[];
  chosen: Layout | null;
  onChoose: (layout: Layout | null) => void;
  lost: readonly string[];
  onApply: () => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-asst-line px-3 py-2">
      <label htmlFor={id} className={labelClass}>
        Change layout from {layoutLabel(current)}
      </label>
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          id={id}
          value={chosen ?? ""}
          aria-describedby={`${id}-said`}
          onChange={(event) => onChoose(event.target.value === "" ? null : (event.target.value as Layout))}
          className={box}
        >
          <option value="">Choose a layout</option>
          {choices.map((one) => (
            <option key={one.layout} value={one.layout}>
              {one.label}
            </option>
          ))}
        </select>
        <button type="button" disabled={chosen === null} onClick={onApply} className={button}>
          Change layout
        </button>
      </div>
      <p id={`${id}-said`} className="text-[12px] text-asst-muted">
        {chosen === null
          ? "The title, speaker notes and as much of the rest as fits carry over."
          : lost.length === 0
            ? `Everything on this slide carries over to ${layoutLabel(chosen)}.`
            : `Changing to ${layoutLabel(chosen)} loses ${lost.join(" and ")}.`}
      </p>
    </div>
  );
}

function AddSlide({
  layout,
  onLayout,
  onAdd,
  after
}: {
  layout: Exclude<Layout, "HMCTS_IMAGE">;
  onLayout: (layout: Exclude<Layout, "HMCTS_IMAGE">) => void;
  onAdd: () => void;
  after: number;
}) {
  const id = useId();
  return (
    <>
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className={labelClass}>
          New slide's layout
        </label>
        <select id={id} value={layout} onChange={(event) => onLayout(event.target.value as Exclude<Layout, "HMCTS_IMAGE">)} className={box}>
          {LAYOUTS.filter((one) => one.layout !== "HMCTS_IMAGE").map((one) => (
            <option key={one.layout} value={one.layout}>
              {one.label}
            </option>
          ))}
        </select>
      </div>
      <button type="button" onClick={onAdd} aria-label={`Add slide after slide ${after}`} className={button}>
        Add slide
      </button>
    </>
  );
}
