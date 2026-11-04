"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { type DeckOutline, plannable, slideReference } from "@/assistant/deck";
import type { DeckSummary, DeckView } from "@/assistant/deck-store";
import { masterNamed, type PlannedSlide, plan } from "@/assistant/slides/masters";
import { useSidebarWidth } from "@/components/assistant/AssistantShell";
import { DeckEditor, type SaveDeckAction, type UnsavedDeckDraft } from "@/components/assistant/DeckEditor";
import { DeckHistory, type RestoreDeckAction } from "@/components/assistant/DeckHistory";
import { backgroundSrc, deckAssetUrl, deckPptxUrl, deckUrl } from "@/components/assistant/deck-addresses";
import { ARTEFACT_MIN_WIDTH, ARTEFACT_WIDTH, CHAT_MIN_WIDTH } from "@/components/assistant/layout";
import { nestRuns, SlideCanvas, slideTitle } from "@/components/assistant/SlideCanvas";
import { useResizableWidth } from "@/components/assistant/useResizableWidth";
import { AnnouncerRegion, useAnnouncer } from "@/components/live/Announcer";
import { ScrollPane } from "@/components/Markup";
import { DownloadIcon } from "@/components/sidebar/icons";

const button = "flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg border border-asst-strong px-2.5 text-[13px] hover:bg-asst-field disabled:opacity-40";

/** A slide the person has asked about: the words their message will start with, and the chip's short name for it. */
export interface SlideAsk {
  reference: string;
  label: string;
}

/**
 * The latest version of the deck, read when the viewer opens and again whenever the page says `version` or
 * `revision` has moved on, the second being a person's amend of their own latest version. The version on screen stays there while the next one is read, and a failed read keeps it too, which
 * `DeckBehind` then says.
 */
export function useDeckView(deck: DeckSummary, conversationId: string): { deck: DeckView | null; failed: boolean; retry: () => void } {
  const { version, revision, pptx } = deck;
  const [read, setRead] = useState<{ deck: DeckView | null; failed: boolean }>({ deck: null, failed: false });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a newer version or revision, or another attempt, is what makes the outline worth reading again
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(deckUrl(conversationId), { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          throw new Error(`the deck read answered ${response.status}`);
        }
        const deck = (await response.json()) as DeckView;
        setRead({ deck, failed: false });
      } catch {
        if (!controller.signal.aborted) {
          setRead((before) => ({ deck: before.deck, failed: true }));
        }
      }
    })();
    return () => controller.abort();
  }, [conversationId, version, revision, attempt]);
  // A .pptx arrives after its version's outline and changes nothing in it, so the page's word on it is taken as it is.
  // The same object comes back until the read or that word changes, so what is keyed on the deck does not run again.
  const shown = useMemo(
    () => (read.deck !== null && read.deck.version === version && (read.deck.revision ?? revision) === revision ? { ...read.deck, pptx } : read.deck),
    [read.deck, version, revision, pptx]
  );
  return { deck: shown, failed: read.failed, retry: () => setAttempt((count) => count + 1) };
}

/** What stands in the viewer's place until the outline has been read, or when it could not be. */
function DeckLoading({ failed, retry }: { failed: boolean; retry: () => void }) {
  return failed ? (
    <div role="alert" className="flex flex-col items-start gap-2 px-4 py-5 text-[13px] text-asst-error">
      Could not load the slides.
      <button type="button" onClick={retry} className={button}>
        Try again
      </button>
    </div>
  ) : (
    <p role="status" className="px-4 py-5 text-[13px] text-asst-muted">
      Loading the slides…
    </p>
  );
}

/**
 * Said over a version older than the page's when reading the newer one failed, so a stale deck never passes for the
 * latest. Everything else on the panel describes the version it shows.
 */
function DeckBehind({ shown, latest, failed, retry }: { shown: DeckView | null; latest: number; failed: boolean; retry: () => void }) {
  if (shown === null || !failed || shown.version >= latest) {
    return null;
  }
  return (
    <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-asst-field bg-asst-raised px-4 py-2.5 text-[13px]">
      <span className="min-w-0 flex-1">
        Couldn't load version {latest}. Showing version {shown.version}.
      </span>
      <button type="button" onClick={retry} className={button}>
        Try again
      </button>
    </div>
  );
}

/** The slides `plan` lays an outline out as, or, when it cannot, the layout it does not know. */
export type PlannedDeck = { slides: PlannedSlide[]; unknownLayout?: undefined } | { slides: null; unknownLayout: string };

/**
 * `plan`, for an outline that may be older than the masters: a version written before a layout was dropped from
 * `masters.ts` still reads, so the viewer says which layout it cannot draw rather than failing as a whole.
 */
export function planDeck(outline: DeckOutline, src: (sha: string) => string): PlannedDeck {
  try {
    return { slides: plan(plannable(outline, src)) };
  } catch (error) {
    const unknown = outline.slides.find((one) => masterNamed(one.layout)?.inSlides !== true)?.layout;
    return { slides: null, unknownLayout: unknown ?? (error instanceof Error ? error.message : String(error)) };
  }
}

export function unknownLayoutMessage(version: number, layout: string): string {
  return `Version ${version} uses a layout this viewer no longer has (${layout}).`;
}

/** The deck's slides as `plan` lays them out, with each picture's address and size. */
function useSlides(conversationId: string, deck: DeckView): { planned: PlannedDeck; sizes: Record<string, { width: number; height: number }> } {
  return useMemo(() => {
    const src = (sha: string) => deckAssetUrl(conversationId, sha);
    const sizes = Object.fromEntries(Object.entries(deck.sizes).map(([sha, size]) => [src(sha), size]));
    return { planned: planDeck(deck.outline, src), sizes };
  }, [conversationId, deck.outline, deck.sizes]);
}

type Bulleted = string | { text: string; bullets?: string[] };

const isBullets = (value: unknown): value is Bulleted[] =>
  Array.isArray(value) &&
  value.every((one) => typeof one === "string" || (typeof one === "object" && one !== null && typeof (one as { text?: unknown }).text === "string"));

/**
 * An outline as text straight from its fields, for a version `plan` cannot lay out: the words of a slide whose layout
 * the viewer no longer has are still there to read, in the order the outline gives them.
 */
function OutlineText({ outline, headingLevel }: { outline: DeckOutline; headingLevel: 2 | 3 | 4 }) {
  const Heading = `h${headingLevel}` as const;
  const slides: Record<string, unknown>[] = [
    { title: outline.title, subtitle: outline.subtitle, notes: outline.notes },
    ...outline.slides.map((one) => one as unknown as Record<string, unknown>)
  ];
  return (
    <ol aria-label="Slides as text" className="flex flex-col gap-6">
      {slides.map((slide, index) => (
        <li key={typeof slide.id === "string" ? slide.id : `slide-${index}`} className="flex flex-col gap-2">
          <Heading className="text-[15px] font-semibold text-asst-text">
            <span className="text-asst-muted">Slide {index + 1}: </span>
            {typeof slide.title === "string" ? slide.title : ""}
          </Heading>
          {Object.entries(slide).map(([field, value]) => {
            if (field === "id" || field === "layout" || field === "title" || field === "notes") {
              return null;
            }
            if (typeof value === "string") {
              return (
                <p key={field} className="text-[13px] text-asst-body">
                  {value}
                </p>
              );
            }
            if (isBullets(value)) {
              return (
                <ul key={field} className="ml-5 list-disc text-[13px] text-asst-body">
                  {value.map((item, i) => {
                    const text = typeof item === "string" ? item : item.text;
                    const children = typeof item === "string" ? [] : (item.bullets ?? []);
                    return (
                      <li key={`${i}-${text}`}>
                        {text}
                        {children.length === 0 ? null : (
                          <ul className="ml-5 list-[circle]">
                            {children.map((child, j) => (
                              <li key={`${j}-${child}`}>{child}</li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              );
            }
            const alt = typeof value === "object" && value !== null ? (value as { alt?: unknown; decorative?: unknown }) : undefined;
            return alt !== undefined && alt.decorative !== true && typeof alt.alt === "string" ? (
              <p key={field} className="text-[13px] text-asst-body">
                <span className="text-asst-muted">Picture: </span>
                {alt.alt}
              </p>
            ) : null;
          })}
          {typeof slide.notes === "string" ? (
            <p className="whitespace-pre-wrap text-[13px] text-asst-muted">
              <span className="font-medium">Speaker notes: </span>
              {slide.notes}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * The deck as headings and lists, slide after slide: everything the slides say, in the order they say it, without the
 * layout. For anyone a slide's geometry gets in the way of, and for copying the words out.
 */
function DeckText({ slides, headingLevel }: { slides: readonly PlannedSlide[]; headingLevel: 2 | 3 | 4 }) {
  const Heading = `h${headingLevel}` as const;
  return (
    <ol aria-label="Slides as text" className="flex flex-col gap-6">
      {slides.map((slide, index) => (
        <li key={slide.id ?? `slide-${index}`} className="flex flex-col gap-2">
          <Heading className="text-[15px] font-semibold text-asst-text">
            <span className="text-asst-muted">Slide {index + 1}: </span>
            {slideTitle(slide)}
          </Heading>
          {slide.boxes.map((box, at) => {
            const key = `${at}-${box.kind}`;
            if (box.kind === "image") {
              return box.decorative ? null : (
                <p key={key} className="text-[13px] text-asst-body">
                  <span className="text-asst-muted">Picture: </span>
                  {box.alt}
                </p>
              );
            }
            if (box.kind !== "text" || box.placeholder === "title") {
              return null;
            }
            if (box.runs.every((run) => run.bullet === null)) {
              return (
                <p key={key} className="text-[13px] text-asst-body">
                  {box.runs.map((run) => run.text).join(" ")}
                </p>
              );
            }
            return (
              <ul key={key} className="ml-5 list-disc text-[13px] text-asst-body">
                {nestRuns(box.runs).map((item, i) => (
                  <li key={`${i}-${item.run.text}`}>
                    {item.run.text}
                    {item.children.length === 0 ? null : (
                      <ul className="ml-5 list-[circle]">
                        {item.children.map((child, j) => (
                          <li key={`${j}-${child.text}`}>{child.text}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            );
          })}
          {slide.notes === undefined ? null : (
            <p className="whitespace-pre-wrap text-[13px] text-asst-muted">
              <span className="font-medium">Speaker notes: </span>
              {slide.notes}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * A deck to look through: a rail of thumbnails, the current slide drawn large, its speaker notes, and the same deck as
 * text. Read-only wherever it is shown; `onAsk`, offered only in the person's own chat, is how they point the
 * assistant at one slide.
 *
 * The rail is one tab stop, moved through with Up, Down, Home and End, and the slide itself takes Page Up, Page Down
 * and the left and right arrows, so the keys that move through a deck in PowerPoint move through this one. Every one
 * of those also has a visible button.
 */
export function DeckViewer({
  conversationId,
  deck,
  announce,
  onAsk,
  headingLevel = 3,
  tools,
  download
}: {
  conversationId: string;
  deck: DeckView;
  /** Says which slide is showing, through the page's one announcer. */
  announce: (text: string) => void;
  onAsk?: (ask: SlideAsk) => void;
  headingLevel?: 2 | 3 | 4;
  /** More of the toolbar's controls, such as the history's. */
  tools?: React.ReactNode;
  /** What stands for the .pptx in place of the link to the one the hub holds. */
  download?: React.ReactNode;
}) {
  const { planned, sizes } = useSlides(conversationId, deck);
  const [chosen, setChosen] = useState(0);
  const [text, setText] = useState(false);
  const rail = useRef<(HTMLButtonElement | null)[]>([]);
  const pptxControl =
    download ??
    (deck.pptx ? (
      <a href={deckPptxUrl(conversationId, deck.version)} download className={`${button} no-underline`}>
        <DownloadIcon />
        Download .pptx
      </a>
    ) : (
      <span className="text-[13px] text-asst-muted">Not built yet</span>
    ));

  if (planned.slides === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div role="toolbar" aria-label="Slides" className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-asst-field px-3 py-1.5">
          {tools}
          <span className="ml-auto text-xs text-asst-faint">Version {deck.version}</span>
          {pptxControl}
        </div>
        <ScrollPane as="section" label="Deck as text" className="min-h-0 flex-1 overflow-y-auto px-[22px] py-5">
          <p role="alert" className="mb-4 text-[13px] text-asst-error">
            {unknownLayoutMessage(deck.version, planned.unknownLayout)} Its slides are shown as text.
          </p>
          <OutlineText outline={deck.outline} headingLevel={headingLevel} />
        </ScrollPane>
      </div>
    );
  }
  const slides = planned.slides;
  // A newer version may have fewer slides than the one being looked at.
  const at = Math.min(chosen, slides.length - 1);
  const slide = slides[at] as PlannedSlide;
  const total = slides.length;

  function go(index: number, focusRail: boolean): void {
    const next = Math.max(0, Math.min(total - 1, index));
    if (next === at) {
      return;
    }
    setChosen(next);
    if (focusRail) {
      rail.current[next]?.focus();
    }
    announce(`Slide ${next + 1} of ${total}: ${slideTitle(slides[next] as PlannedSlide)}`);
  }

  function onRailKey(event: React.KeyboardEvent<HTMLButtonElement>): void {
    const moves: Record<string, number> = { ArrowUp: at - 1, ArrowDown: at + 1, Home: 0, End: total - 1 };
    const target = moves[event.key];
    if (target !== undefined) {
      event.preventDefault();
      go(target, true);
    }
  }

  function onSlideKey(event: React.KeyboardEvent<HTMLElement>): void {
    const back = event.key === "PageUp" || event.key === "ArrowLeft";
    const forward = event.key === "PageDown" || event.key === "ArrowRight";
    if (back || forward) {
      event.preventDefault();
      go(forward ? at + 1 : at - 1, false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="toolbar" aria-label="Slides" className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-asst-field px-3 py-1.5">
        <button type="button" aria-pressed={text} onClick={() => setText(!text)} className={button}>
          Text view
        </button>
        {onAsk === undefined || text ? null : (
          <button
            type="button"
            onClick={() => onAsk({ reference: slideReference(deck, at, slideTitle(slide), slide.id), label: `Slide ${at + 1}: ${slideTitle(slide)}` })}
            className={button}
          >
            Ask about this slide
          </button>
        )}
        {tools}
        <span className="ml-auto text-xs text-asst-faint">Version {deck.version}</span>
        {pptxControl}
      </div>
      {text ? (
        <ScrollPane as="section" label="Deck as text" className="min-h-0 flex-1 overflow-y-auto px-[22px] py-5">
          <DeckText slides={slides} headingLevel={headingLevel} />
        </ScrollPane>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ol aria-label="Slide thumbnails" className="flex w-[118px] shrink-0 flex-col gap-2 overflow-y-auto border-r border-asst-field p-2">
            {slides.map((one, index) => (
              <li key={one.id ?? `slide-${index}`}>
                <button
                  ref={(element) => {
                    rail.current[index] = element;
                  }}
                  type="button"
                  tabIndex={index === at ? 0 : -1}
                  aria-current={index === at ? "true" : undefined}
                  onClick={() => go(index, false)}
                  onKeyDown={onRailKey}
                  className={`flex w-full flex-col gap-1 rounded-md p-1 text-left ${index === at ? "bg-asst-active outline-2 outline-asst-accent" : "hover:bg-asst-field"}`}
                >
                  {/*
                    Named by text inside it rather than an aria-label, which would have to begin with every word the
                    drawn thumbnail shows (WCAG 2.5.3); the drawing itself is hidden and the name says the same.
                  */}
                  <span aria-hidden="true" className="text-[11px] text-asst-muted">
                    {index + 1}
                  </span>
                  <span className="sr-only">{`Slide ${index + 1}: ${slideTitle(one)}`}</span>
                  <span aria-hidden="true" className="pointer-events-none block w-full rounded-sm border border-asst-line">
                    <SlideCanvas slide={one} index={index} total={total} backgroundSrc={backgroundSrc} sizes={sizes} thumbnail />
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
            <div className="rounded-md border border-asst-line">
              <SlideCanvas
                slide={slide}
                index={at}
                total={total}
                backgroundSrc={backgroundSrc}
                sizes={sizes}
                headingLevel={headingLevel}
                onKeyDown={onSlideKey}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={() => go(at - 1, false)} disabled={at === 0} className={button}>
                Previous slide
              </button>
              <button type="button" onClick={() => go(at + 1, false)} disabled={at === total - 1} className={button}>
                Next slide
              </button>
              <span className="ml-auto text-xs text-asst-muted">
                {at + 1} of {total}
              </span>
            </div>
            {slide.notes === undefined ? null : (
              <details className="rounded-lg border border-asst-line px-3 py-2 text-[13px]">
                <summary className="cursor-pointer text-asst-body">Speaker notes</summary>
                <p className="mt-2 whitespace-pre-wrap text-asst-body">{slide.notes}</p>
              </details>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The conversation's deck beside the chat, in the document panel's shell: the same resizable width, close button and
 * header, so the two read as one kind of thing. The width is kept apart from the document's, since a deck is looked at
 * wider than a document is written. The page hands it the deck's version; the outline is read here (`useDeckView`).
 *
 * With `save`, which only the chat's owner is handed, "Edit slides" turns the panel into the editor on the latest
 * version, and Done turns it back. An edit the editor could not save comes back through `onUnsaved`, and the page
 * opens the panel again with it as `draft`, straight into the editor, which takes it once (`onDraftTaken`): every
 * later "Edit slides" starts from the latest version.
 */
export function DeckPanel({
  conversationId,
  deck,
  onClose,
  narrow,
  announce,
  onAsk,
  restore,
  save,
  onBusy,
  draft,
  onDraftTaken,
  onUnsaved
}: {
  conversationId: string;
  deck: DeckSummary;
  onClose: () => void;
  narrow: boolean;
  announce: (text: string) => void;
  onAsk?: (ask: SlideAsk) => void;
  restore?: RestoreDeckAction;
  /** Left out, the slides are not editable here. */
  save?: SaveDeckAction;
  onBusy?: (busy: boolean) => void;
  draft?: UnsavedDeckDraft;
  onDraftTaken?: () => void;
  onUnsaved?: (draft: UnsavedDeckDraft) => void;
}) {
  const view = useDeckView(deck, conversationId);
  const [editing, setEditing] = useState(draft !== undefined);
  // Held here as well as by the page, so no editor but the first is handed it, whoever renders the panel.
  const [handed, setHanded] = useState(draft);
  const editable = save !== undefined && view.deck !== null;
  const sidebarWidth = useSidebarWidth();
  const resize = useResizableWidth({
    storageKey: "hmcts-assistant-deck-width",
    label: "Resize slides panel",
    initial: ARTEFACT_WIDTH,
    min: ARTEFACT_MIN_WIDTH,
    reserve: () => CHAT_MIN_WIDTH + sidebarWidth,
    edge: "right"
  });

  return (
    <section
      aria-label="Slides"
      className={`z-[25] flex h-full shrink-0 flex-col border-l border-asst-line bg-asst-panel ${narrow ? "fixed inset-0" : "relative"}`}
      style={narrow ? undefined : { width: resize.width }}
    >
      {narrow ? null : (
        <div
          {...resize.separator}
          className="absolute -left-1 bottom-0 top-0 z-[2] w-2 cursor-col-resize hover:bg-asst-accent/25 focus:bg-asst-accent/40 focus:outline-hidden"
        />
      )}
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-asst-field pl-4 pr-3">
        <span aria-hidden="true" className="shrink-0 font-plex-mono text-[11px] uppercase tracking-wider text-asst-accent-soft">
          .pptx
        </span>
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-medium text-asst-text">{view.deck?.title ?? deck.title}</h2>
        {editable && !editing ? (
          <button
            type="button"
            onClick={() => {
              setEditing(true);
              announce("Editing the slides");
            }}
            className={button}
          >
            Edit slides
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close slides"
          className="h-8 w-8 shrink-0 rounded-lg text-xl leading-none text-asst-muted hover:bg-asst-field hover:text-asst-text"
        >
          ×
        </button>
      </div>
      <DeckBehind shown={view.deck} latest={deck.version} failed={view.failed} retry={view.retry} />
      {view.deck === null ? (
        <DeckLoading failed={view.failed} retry={view.retry} />
      ) : editing && save !== undefined ? (
        <DeckEditor
          conversationId={conversationId}
          deck={view.deck}
          save={save}
          announce={announce}
          onDone={() => {
            setEditing(false);
            announce("Finished editing the slides");
          }}
          onBusy={onBusy}
          draft={handed}
          onDraftTaken={() => {
            setHanded(undefined);
            onDraftTaken?.();
          }}
          onUnsaved={onUnsaved}
          narrow={narrow}
        />
      ) : (
        <DeckHistory conversationId={conversationId} latest={view.deck} announce={announce} onAsk={onAsk} owner restore={restore} />
      )}
    </section>
  );
}

/**
 * The deck on a shared chat's page, read-only: no asking about a slide, since the reader has no composer, and the
 * page's own announcer, since a share page has none of the chat's.
 */
export function SharedDeck({ conversationId, deck }: { conversationId: string; deck: DeckSummary }) {
  const view = useDeckView(deck, conversationId);
  const slides = useAnnouncer("slides");
  return (
    <section aria-labelledby="shared-deck" className="flex h-[min(640px,80vh)] flex-col overflow-hidden rounded-2xl border border-asst-line">
      <h2 id="shared-deck" className="shrink-0 border-b border-asst-field px-5 py-3 text-[18px] font-semibold">
        {view.deck?.title ?? deck.title}
      </h2>
      <DeckBehind shown={view.deck} latest={deck.version} failed={view.failed} retry={view.retry} />
      {view.deck === null ? (
        <DeckLoading failed={view.failed} retry={view.retry} />
      ) : (
        <DeckHistory conversationId={conversationId} latest={view.deck} announce={slides.announce} owner={false} />
      )}
      <AnnouncerRegion text={slides.text} />
    </section>
  );
}
