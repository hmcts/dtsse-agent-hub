"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { RestoreDeckResult } from "@/app/_actions/decks";
import { plannable } from "@/assistant/deck";
import type { DeckBuildRequest, DeckBuildView } from "@/assistant/deck-build";
import { type DeckDiff, diffDecks, diffSummary, type FieldChange, type SlideDiff, type WordPart } from "@/assistant/deck-diff";
import type { DeckVersionEntry, DeckVersionView } from "@/assistant/deck-history-store";
import type { DeckView } from "@/assistant/deck-store";
import { type PlannedSlide, plan } from "@/assistant/slides/masters";
import { DeckViewer, deckAssetUrl, deckPptxUrl, deckUrl, type SlideAsk } from "@/components/assistant/DeckPanel";
import { SlideCanvas } from "@/components/assistant/SlideCanvas";
import { ScrollPane } from "@/components/Markup";
import { DownloadIcon } from "@/components/sidebar/icons";
import type { ActionResult } from "@/web/action";

/**
 * A deck's kept versions, beside the latest one the panel shows: a list to pick one from, that version shown read-only
 * under a banner saying it is not the latest, a comparison of it with the latest, and, for the chat's owner alone, a
 * restore of it as the next version and a build of any version's .pptx the hub does not hold. A share recipient may
 * look through every version and download what is already built, and nothing else; the routes refuse the rest anyway.
 */

export function deckVersionsUrl(conversationId: string): string {
  return `${deckUrl(conversationId)}/versions`;
}

export function deckVersionUrl(conversationId: string, version: number): string {
  return `${deckUrl(conversationId)}/versions/${version}`;
}

export function deckBuildUrl(conversationId: string, jobId: string): string {
  return `${deckUrl(conversationId)}/builds/${encodeURIComponent(jobId)}`;
}

/** The restore server action, handed down from the chat's page, which a shared page never has. */
export type RestoreDeckAction = (input: { conversationId: unknown; version: unknown; baseVersion: unknown }) => Promise<ActionResult<RestoreDeckResult>>;

const button = "flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg border border-asst-strong px-2.5 text-[13px] hover:bg-asst-field disabled:opacity-40";

const backgroundSrc = (image: string): string => `/assistant/slides/${image}`;

/** How often a build being prepared is read back. */
export const BUILD_POLL_MS = 2000;

async function readJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`);
  }
  return (await response.json()) as T;
}

/** The kept versions, read when the list opens and again whenever the latest version moves on while it is open. */
function useVersions(conversationId: string, latest: number, open: boolean) {
  const [state, setState] = useState<{ versions: DeckVersionEntry[] | null; failed: boolean }>({ versions: null, failed: false });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a newer latest version, or another attempt, is what makes the list worth reading again
  useEffect(() => {
    if (!open) {
      return;
    }
    const controller = new AbortController();
    readJson<DeckVersionEntry[]>(deckVersionsUrl(conversationId), controller.signal).then(
      (versions) => setState({ versions, failed: false }),
      () => {
        if (!controller.signal.aborted) {
          setState((before) => ({ versions: before.versions, failed: true }));
        }
      }
    );
    return () => controller.abort();
  }, [conversationId, latest, open, attempt]);
  return { ...state, retry: () => setAttempt((count) => count + 1) };
}

/** One older version, outline and all; `null` while it is read, and kept once read since a version never changes. */
function useVersion(conversationId: string, version: number | null) {
  const [read, setRead] = useState<{ version: DeckVersionView | null; failed: boolean }>({ version: null, failed: false });
  useEffect(() => {
    if (version === null) {
      setRead({ version: null, failed: false });
      return;
    }
    const controller = new AbortController();
    setRead({ version: null, failed: false });
    readJson<DeckVersionView>(deckVersionUrl(conversationId, version), controller.signal).then(
      (found) => setRead({ version: found, failed: false }),
      () => {
        if (!controller.signal.aborted) {
          setRead({ version: null, failed: true });
        }
      }
    );
    return () => controller.abort();
  }, [conversationId, version]);
  return read;
}

/** An older version in the shape the viewer draws. */
function asView(version: DeckVersionView): DeckView {
  return {
    title: version.title,
    outline: version.outline,
    version: version.version,
    updatedBy: version.by,
    updatedAt: version.created_at,
    pptx: version.pptx,
    sizes: version.sizes
  };
}

const when = (iso: string): string =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

function who(by: DeckVersionEntry["by"], owner: boolean): string {
  if (by === "agent") {
    return "Assistant";
  }
  return owner ? "You" : "The chat's owner";
}

/** Starts the browser's download of `href`, as clicking a link to it would. */
function download(href: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
}

type Building = { state: "idle" } | { state: "asking" } | { state: "preparing"; jobId: string } | { state: "ready" } | { state: "failed"; message: string };

const NOT_STARTED: Record<"waking" | "unsupported", string> = {
  waking: "Your assistant is starting up. Try again in a minute.",
  unsupported: "Your assistant needs an update before it can build this version. It gets one the next time it restarts."
};

/**
 * One version's .pptx: a download when the hub holds it, and otherwise, for the owner, a build by their pod, read back
 * until it is ready and then downloaded. Anyone else is told it is not available.
 */
export function DeckDownload({
  conversationId,
  version,
  pptx,
  canBuild,
  latest,
  announce,
  pollMs = BUILD_POLL_MS
}: {
  conversationId: string;
  version: number;
  pptx: boolean;
  canBuild: boolean;
  /** The latest version, which the session builds itself, says "Not built yet" rather than "Not available". */
  latest: boolean;
  announce: (text: string) => void;
  pollMs?: number;
}) {
  const [building, setBuilding] = useState<Building>({ state: "idle" });
  const href = deckPptxUrl(conversationId, version);

  // biome-ignore lint/correctness/useExhaustiveDependencies: another version starts again from what the hub holds of it
  useEffect(() => setBuilding({ state: "idle" }), [conversationId, version]);

  const finished = useCallback(
    (answer: DeckBuildView) => {
      if (answer.status === "done") {
        setBuilding({ state: "ready" });
        announce(`Version ${version} is ready to download`);
        download(href);
      } else if (answer.status !== "pending") {
        const message = answer.status === "timeout" ? "Building this version took too long." : (answer.error ?? "This version could not be built.");
        setBuilding({ state: "failed", message });
        announce(`Version ${version} could not be prepared`);
      }
    },
    [announce, href, version]
  );

  useEffect(() => {
    if (building.state !== "preparing") {
      return;
    }
    let stopped = false;
    const timer = setInterval(() => {
      readJson<DeckBuildView>(deckBuildUrl(conversationId, building.jobId)).then(
        (answer) => {
          if (!stopped) {
            finished(answer);
          }
        },
        () => undefined
      );
    }, pollMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [building, conversationId, finished, pollMs]);

  async function prepare(): Promise<void> {
    setBuilding({ state: "asking" });
    try {
      const response = await fetch(href, { method: "POST", cache: "no-store" });
      const answer = (await response.json().catch(() => ({}))) as DeckBuildRequest | { error?: string };
      if (!response.ok || !("status" in answer)) {
        setBuilding({ state: "failed", message: ("error" in answer && answer.error) || "This version could not be prepared." });
        return;
      }
      if (answer.status === "ready") {
        setBuilding({ state: "ready" });
        download(href);
      } else if (answer.status === "pending") {
        setBuilding({ state: "preparing", jobId: answer.job_id });
        announce(`Preparing version ${version}`);
      } else {
        setBuilding({ state: "failed", message: NOT_STARTED[answer.status] });
      }
    } catch {
      setBuilding({ state: "failed", message: "This version could not be prepared." });
    }
  }

  if (pptx || building.state === "ready") {
    return (
      <a href={href} download className={`${button} no-underline`}>
        <DownloadIcon />
        Download .pptx
      </a>
    );
  }
  if (!canBuild) {
    return <span className="text-[13px] text-asst-muted">{latest ? "Not built yet" : "Not available"}</span>;
  }
  if (building.state === "asking" || building.state === "preparing") {
    return (
      <span role="status" className="flex items-center gap-1.5 text-[13px] text-asst-muted">
        <span aria-hidden="true" className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-asst-strong border-t-transparent" />
        Preparing…
      </span>
    );
  }
  if (building.state === "failed") {
    return (
      <span role="alert" className="flex flex-wrap items-center gap-1.5 text-[13px] text-asst-error">
        {building.message}
        <button type="button" onClick={() => void prepare()} className={button}>
          Try again
        </button>
      </span>
    );
  }
  return (
    <button type="button" onClick={() => void prepare()} className={button}>
      <DownloadIcon />
      Prepare .pptx
    </button>
  );
}

/** The kept versions, newest first, as buttons; the one on screen is `aria-current`. */
function VersionList({
  id,
  versions,
  failed,
  retry,
  latest,
  showing,
  owner,
  onPick
}: {
  id: string;
  versions: DeckVersionEntry[] | null;
  failed: boolean;
  retry: () => void;
  latest: number;
  showing: number;
  owner: boolean;
  onPick: (version: number) => void;
}) {
  const headingId = useId();
  return (
    <section id={id} aria-labelledby={headingId} className="max-h-[40%] shrink-0 overflow-y-auto border-b border-asst-field px-3 py-2">
      <h3 id={headingId} className="mb-1.5 text-[13px] font-semibold text-asst-text">
        Version history
      </h3>
      {versions === null ? (
        failed ? (
          <p role="alert" className="flex items-center gap-2 text-[13px] text-asst-error">
            Could not load the history.
            <button type="button" onClick={retry} className={button}>
              Try again
            </button>
          </p>
        ) : (
          <p role="status" className="text-[13px] text-asst-muted">
            Loading the history…
          </p>
        )
      ) : (
        <ol aria-label="Versions" className="flex flex-col gap-1">
          {versions.map((entry) => (
            <li key={entry.version}>
              <button
                type="button"
                aria-current={entry.version === showing ? "true" : undefined}
                onClick={() => onPick(entry.version)}
                className={`flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left text-[13px] ${entry.version === showing ? "bg-asst-active outline-2 outline-asst-accent" : "hover:bg-asst-field"}`}
              >
                <span className="font-medium text-asst-text">
                  Version {entry.version}
                  {entry.version === latest ? " (latest)" : ""}
                </span>
                <span className="text-asst-muted">
                  {who(entry.by, owner)}, {when(entry.created_at)}
                </span>
                {entry.summary === null ? null : <span className="text-asst-body">{entry.summary}</span>}
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Words({ parts }: { parts: WordPart[] }) {
  return (
    <span className="whitespace-pre-line">
      {parts.map((part, index) => {
        const lead = /^\s*/.exec(part.text)?.[0] ?? "";
        const words = part.text.slice(lead.length);
        const key = `${index}-${part.kind}`;
        if (part.kind === "same") {
          return <span key={key}>{part.text}</span>;
        }
        const Tag = part.kind === "added" ? "ins" : "del";
        return (
          <span key={key}>
            {lead}
            <Tag
              className={
                part.kind === "added"
                  ? "rounded-sm bg-asst-accent/15 text-asst-text underline decoration-2 underline-offset-2"
                  : "rounded-sm text-asst-muted line-through decoration-2"
              }
            >
              <span className="sr-only">{part.kind === "added" ? "added: " : "removed: "}</span>
              {words}
            </Tag>
          </span>
        );
      })}
    </span>
  );
}

function Fields({ fields }: { fields: FieldChange[] }) {
  return (
    <dl className="flex flex-col gap-1.5 text-[13px] text-asst-body">
      {fields.map((field) => (
        <div key={field.field}>
          <dt className="font-medium text-asst-muted">{field.label}</dt>
          <dd>
            <Words parts={field.parts} />
            {field.note === undefined ? null : <span className="block italic text-asst-muted">{field.note}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const MARKS: Record<Exclude<SlideDiff["status"], "same">, { icon: string; text: string }> = {
  added: { icon: "+", text: "Added" },
  removed: { icon: "−", text: "Removed" },
  moved: { icon: "↕", text: "Moved" },
  changed: { icon: "✎", text: "Changed" }
};

function Mark({ status, moved }: { status: Exclude<SlideDiff["status"], "same">; moved: boolean }) {
  const mark = MARKS[status];
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-asst-strong px-2 py-0.5 text-[12px] font-medium text-asst-text">
      <span aria-hidden="true">{status === "changed" && moved ? `${mark.icon}${MARKS.moved.icon}` : mark.icon}</span>
      {status === "changed" && moved ? "Changed and moved" : mark.text}
    </span>
  );
}

function slidesOf(conversationId: string, view: DeckView): PlannedSlide[] {
  return plan(plannable(view.outline, (sha) => deckAssetUrl(conversationId, sha)));
}

function sizesOf(conversationId: string, view: DeckView) {
  return Object.fromEntries(Object.entries(view.sizes).map(([sha, size]) => [deckAssetUrl(conversationId, sha), size]));
}

/** "Slide 3" as the drawn deck counts, the title slide being 1, for each version the slide is in. */
function where(slide: SlideDiff): string {
  const at = (place: { index: number } | undefined) => (place === undefined ? undefined : place.index + 2);
  const before = at(slide.before);
  const after = at(slide.after);
  if (before !== undefined && after !== undefined && before !== after) {
    return `Slide ${before}, now slide ${after}`;
  }
  return `Slide ${after ?? before}`;
}

/**
 * The older version against the latest, slide by slide in the latest's order: each slide added, removed, moved or
 * changed, said in words beside an icon, and a changed slide drawn in both versions, side by side where there is room.
 */
export function DeckCompare({ conversationId, older, latest, onBack }: { conversationId: string; older: DeckView; latest: DeckView; onBack: () => void }) {
  const diff: DeckDiff = useMemo(() => diffDecks(older.outline, latest.outline), [older.outline, latest.outline]);
  const drawn = useMemo(
    () => ({
      older: slidesOf(conversationId, older),
      latest: slidesOf(conversationId, latest),
      olderSizes: sizesOf(conversationId, older),
      latestSizes: sizesOf(conversationId, latest)
    }),
    [conversationId, older, latest]
  );
  const shown = diff.slides.filter((slide) => slide.status !== "same");
  const canvas = (side: "older" | "latest", index: number) => {
    const slides = side === "older" ? drawn.older : drawn.latest;
    const slide = slides[index + 1];
    return slide === undefined ? null : (
      <span aria-hidden="true" className="pointer-events-none block w-full rounded-sm border border-asst-line">
        <SlideCanvas
          slide={slide}
          index={index + 1}
          total={slides.length}
          backgroundSrc={backgroundSrc}
          sizes={side === "older" ? drawn.olderSizes : drawn.latestSizes}
          thumbnail
        />
      </span>
    );
  };
  return (
    <ScrollPane as="section" label={`Version ${older.version} compared with the latest`} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-[15px] font-semibold text-asst-text">
          Version {older.version} compared with the latest, version {latest.version}
        </h3>
        <button type="button" onClick={onBack} className={`${button} ml-auto`}>
          Back to version {older.version}
        </button>
      </div>
      <p className="mb-3 text-[13px] text-asst-body">{diffSummary(diff)}.</p>
      <ol aria-label="Differences" className="flex flex-col gap-4">
        {diff.deck.length === 0 ? null : (
          <li className="flex flex-col gap-2 rounded-lg border border-asst-line p-3">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-[14px] font-semibold text-asst-text">Slide 1: the title slide</h4>
              <Mark status="changed" moved={false} />
            </div>
            <Fields fields={diff.deck} />
          </li>
        )}
        {shown.map((slide) => {
          const title = slide.after?.slide.title ?? slide.before?.slide.title ?? "";
          return (
            <li key={slide.id} className="flex flex-col gap-2 rounded-lg border border-asst-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-[14px] font-semibold text-asst-text">
                  {where(slide)}: {title}
                </h4>
                <Mark status={slide.status as Exclude<SlideDiff["status"], "same">} moved={slide.moved} />
              </div>
              {slide.status === "changed" && slide.before !== undefined && slide.after !== undefined ? (
                <>
                  <Fields fields={slide.fields} />
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <figure className="flex flex-col gap-1">
                      {canvas("older", slide.before.index)}
                      <figcaption className="text-[12px] text-asst-muted">Version {older.version}</figcaption>
                    </figure>
                    <figure className="flex flex-col gap-1">
                      {canvas("latest", slide.after.index)}
                      <figcaption className="text-[12px] text-asst-muted">Latest, version {latest.version}</figcaption>
                    </figure>
                  </div>
                </>
              ) : (
                <div className="w-full max-w-[240px]">
                  {slide.status === "removed" && slide.before !== undefined
                    ? canvas("older", slide.before.index)
                    : slide.after !== undefined
                      ? canvas("latest", slide.after.index)
                      : null}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </ScrollPane>
  );
}

/**
 * The deck with its history: the viewer, drawing the latest version or the one picked from the list, the list itself
 * behind the toolbar's History, and the comparison. `owner` is whether the viewer may build, and with `restore` restore,
 * which only the chat's own page says; a shared page never does.
 */
export function DeckHistory({
  conversationId,
  latest,
  announce,
  onAsk,
  owner,
  restore: restoreAction,
  headingLevel
}: {
  conversationId: string;
  latest: DeckView;
  announce: (text: string) => void;
  onAsk?: (ask: SlideAsk) => void;
  owner: boolean;
  restore?: RestoreDeckAction;
  headingLevel?: 2 | 3 | 4;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [comparing, setComparing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const listId = useId();
  const versions = useVersions(conversationId, latest.version, open);
  const viewing = picked !== null && picked !== latest.version ? picked : null;
  const older = useVersion(conversationId, viewing);

  function pick(version: number): void {
    setComparing(false);
    setRefusal(null);
    if (version === latest.version) {
      setPicked(null);
      announce(`Showing the latest version, version ${latest.version}`);
      return;
    }
    setPicked(version);
    announce(`Showing version ${version}, not the latest`);
  }

  function backToLatest(): void {
    setPicked(null);
    setComparing(false);
    setRefusal(null);
    announce(`Showing the latest version, version ${latest.version}`);
  }

  function compare(view: DeckView): void {
    setComparing(true);
    announce(`Comparing version ${view.version} with the latest. ${diffSummary(diffDecks(view.outline, latest.outline))}`);
  }

  async function restore(version: number): Promise<void> {
    if (restoreAction === undefined) {
      return;
    }
    setRestoring(true);
    setRefusal(null);
    try {
      const result = await restoreAction({ conversationId, version, baseVersion: latest.version });
      if (!result.ok) {
        setRefusal(result.error);
      } else if (result.restored) {
        announce(`Restored version ${version} as version ${result.version}`);
        setPicked(null);
        setComparing(false);
      } else {
        setRefusal(
          `The slides changed while you were looking: they are now version ${result.current.version}. Nothing was restored. Look at the latest, then try again.`
        );
      }
    } finally {
      setRestoring(false);
    }
  }

  const toggle = (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={listId}
      onClick={() => {
        setOpen(!open);
        announce(open ? "Version history closed" : "Version history opened");
      }}
      className={button}
    >
      History
    </button>
  );

  const view = viewing === null ? latest : older.version === null ? null : asView(older.version);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {open ? (
        <VersionList
          id={listId}
          versions={versions.versions}
          failed={versions.failed}
          retry={versions.retry}
          latest={latest.version}
          showing={viewing ?? latest.version}
          owner={owner}
          onPick={pick}
        />
      ) : null}
      {viewing === null ? null : (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-asst-field bg-asst-field/60 px-3 py-2 text-[13px]">
          <p className="font-medium text-asst-text">
            <span aria-hidden="true">⏱ </span>
            Viewing version {viewing} (not the latest)
          </p>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {view === null || comparing ? null : (
              <button type="button" onClick={() => compare(view)} className={button}>
                Compare with latest
              </button>
            )}
            {owner && restoreAction !== undefined ? (
              <button type="button" disabled={restoring} onClick={() => void restore(viewing)} className={button}>
                {restoring ? "Restoring…" : "Restore this version"}
              </button>
            ) : null}
            <button type="button" onClick={backToLatest} className={button}>
              Back to latest
            </button>
          </div>
          {refusal === null ? null : (
            <p role="alert" className="w-full text-asst-error">
              {refusal}
            </p>
          )}
        </div>
      )}
      {view === null ? (
        older.failed ? (
          <div role="alert" className="flex flex-col items-start gap-2 px-4 py-5 text-[13px] text-asst-error">
            Could not load version {viewing}.
            <button type="button" onClick={backToLatest} className={button}>
              Back to latest
            </button>
          </div>
        ) : (
          <p role="status" className="px-4 py-5 text-[13px] text-asst-muted">
            Loading version {viewing}…
          </p>
        )
      ) : comparing && viewing !== null ? (
        <DeckCompare conversationId={conversationId} older={view} latest={latest} onBack={() => setComparing(false)} />
      ) : (
        <DeckViewer
          conversationId={conversationId}
          deck={view}
          announce={announce}
          onAsk={viewing === null ? onAsk : undefined}
          headingLevel={headingLevel}
          tools={toggle}
          download={
            <DeckDownload
              conversationId={conversationId}
              version={view.version}
              pptx={view.pptx}
              canBuild={owner}
              latest={viewing === null}
              announce={announce}
            />
          }
        />
      )}
    </div>
  );
}
