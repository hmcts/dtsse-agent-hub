"use client";

import Link from "next/link";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MentionPerson } from "@/components/feedback/MentionInput";
import { CommentBody, STATUS_WORDS, ThreadCard } from "@/components/feedback/ThreadCard";
import { Timestamp } from "@/components/time/Timestamp";
import { describeElement } from "@/feedback/anchor-words";
import { MAX_REFINE_THREADS, MAX_THEME, type RefineMode } from "@/feedback/refinement";
import type { FeedbackLinkView } from "@/feedback/store";
import { filterThreads, marginOrder, NO_FILTER, type PageGroup, pageName, pagesOf, type ThreadFilter } from "@/feedback/team-views";
import type { FeedbackThreadStatus, FeedbackThreadView } from "@/feedback/thread-store";
import { FIELD, LINK, PRIMARY, plural, reviewPath, SECONDARY } from "./look";
import { type Highlight, SnapshotView } from "./SnapshotView";

/**
 * The project's comments, two ways. `page`, the first a person sees, is a document's margin: pick a page, and its
 * snapshot is shown with the selected thread's element outlined and a line to that thread's card, the page's cards
 * down the right in the order their elements are down the page. `list` is every comment that matches the filters in
 * one list, grouped by page or theme, where comments are chosen, themed and refined; choosing a comment's "View on
 * page" there opens it in `page`. Threads whose element has gone are listed apart, under the page's others.
 */

export type CommentsMode = "list" | "page";

export interface ThreadHandlers {
  reply: (threadId: string, body: string) => Promise<string | null>;
  status: (threadId: string, status: "open" | "resolved") => Promise<string | null>;
  /** Gives threads a theme, or clears it with null; without it, the list lets nobody choose comments. */
  theme?: (threadIds: string[], theme: string | null) => Promise<string | null>;
  /** Starts refining threads with the Assistant, into one story or comment by comment, and goes to the chat; without it, refining is not offered. */
  refine?: (threadIds: string[], mode: RefineMode) => Promise<string | null>;
}

const GUTTER = 28;

const keyOf = (page: { linkId: string; pagePath: string }): string => `${page.linkId} ${page.pagePath}`;

export function CommentsView({
  projectId,
  threads,
  links,
  people,
  handlers,
  initial = NO_FILTER,
  initialMode = "page",
  initialThread = null
}: Readonly<{
  projectId: string;
  threads: readonly FeedbackThreadView[];
  links: readonly Pick<FeedbackLinkView, "id" | "label" | "token" | "revokedAt">[];
  people: readonly MentionPerson[];
  handlers: ThreadHandlers;
  initial?: ThreadFilter;
  initialMode?: CommentsMode;
  /** A thread to open on its page, as the one chosen; one not among `threads` is ignored. */
  initialThread?: string | null;
}>) {
  const ids = useId();
  const opening = threads.find((thread) => thread.id === initialThread);
  const [mode, setMode] = useState<CommentsMode>(opening === undefined ? initialMode : "page");
  const [filter, setFilter] = useState<ThreadFilter>(initial);
  const [pageKey, setPageKey] = useState<string | null>(opening === undefined ? null : keyOf(opening));
  const [chosen, setChosen] = useState<string | null>(opening?.id ?? null);
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const [cardTop, setCardTop] = useState<number | null>(null);
  const cards = useRef(new Map<string, HTMLElement>());

  const reviewers = useMemo(() => {
    const seen = new Map<string, string>();
    for (const thread of threads) {
      seen.set(thread.author.oid, thread.author.name);
    }
    return [...seen].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  }, [threads]);
  const narrowed = filterThreads(threads, { ...filter, pagePath: null });
  const pages = pagesOf(narrowed);
  const page = pages.find((p) => keyOf(p) === pageKey) ?? pages[0];
  const onPage = page === undefined ? [] : narrowed.filter((thread) => thread.linkId === page.linkId && thread.pagePath === page.pagePath);
  const { onPage: margin, detached } = marginOrder(onPage);
  const selected = [...margin, ...detached].find((thread) => thread.id === chosen) ?? margin[0] ?? detached[0];
  const link = links.find((l) => l.id === page?.linkId);
  const linkLabel = (id: string) => links.find((l) => l.id === id)?.label ?? "a removed link";

  function viewOnPage(thread: FeedbackThreadView): void {
    setMode("page");
    setPageKey(keyOf(thread));
    setChosen(thread.id);
  }

  // Measured after every render: a reply or a resolve changes a card's height and so where the next one sits.
  useLayoutEffect(() => {
    const element = selected === undefined ? undefined : cards.current.get(selected.id);
    const top = element === undefined ? null : element.offsetTop + Math.min(24, element.offsetHeight / 2);
    setCardTop((current) => (current === top ? current : top));
  });

  function change(next: Partial<ThreadFilter>): void {
    setFilter((current) => ({ ...current, ...next }));
    setPageKey(null);
    setChosen(null);
  }

  const card = (thread: FeedbackThreadView, index: number) => (
    <li
      key={thread.id}
      ref={(element) => {
        if (element === null) {
          cards.current.delete(thread.id);
        } else {
          cards.current.set(thread.id, element);
        }
      }}
    >
      <ThreadCard
        thread={thread}
        people={people}
        number={thread.status === "detached" ? undefined : index + 1}
        focused={thread.id === selected?.id}
        onFocus={() => setChosen(thread.id)}
        onReply={(body) => handlers.reply(thread.id, body)}
        onStatus={(status) => handlers.status(thread.id, status)}
      />
    </li>
  );

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <nav aria-label="Filter comments" className="flex shrink-0 flex-col gap-1.5 lg:w-52">
        <label className="text-xs text-asst-faint" htmlFor={`${ids}-link`}>
          Link
        </label>
        <select id={`${ids}-link`} value={filter.linkId ?? ""} onChange={(event) => change({ linkId: event.target.value || null })} className={FIELD}>
          <option value="">All links</option>
          {links.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
              {l.revokedAt === null ? "" : " (turned off)"}
            </option>
          ))}
        </select>
        <label className="pt-1.5 text-xs text-asst-faint" htmlFor={`${ids}-who`}>
          Reviewer
        </label>
        <select id={`${ids}-who`} value={filter.authorOid ?? ""} onChange={(event) => change({ authorOid: event.target.value || null })} className={FIELD}>
          <option value="">Everyone</option>
          {reviewers.map(([oid, name]) => (
            <option key={oid} value={oid}>
              {name}
            </option>
          ))}
        </select>
        <label className="pt-1.5 text-xs text-asst-faint" htmlFor={`${ids}-status`}>
          Status
        </label>
        <select
          id={`${ids}-status`}
          value={filter.status ?? ""}
          onChange={(event) => change({ status: (event.target.value || null) as FeedbackThreadStatus | null })}
          className={FIELD}
        >
          <option value="">Any status</option>
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="detached">{STATUS_WORDS.detached}</option>
        </select>
        {mode === "list" ? null : <h3 className="pt-2.5 text-xs text-asst-faint">Pages</h3>}
        {mode === "list" ? null : pages.length === 0 ? (
          <p className="text-[13px] text-asst-muted">No pages have comments that match.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {pages.map((p) => {
              const current = p === page;
              return (
                <li key={keyOf(p)}>
                  <button
                    type="button"
                    aria-current={current ? "page" : undefined}
                    onClick={() => {
                      setPageKey(keyOf(p));
                      setChosen(null);
                    }}
                    className={`flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left text-[13px] ${current ? "bg-asst-active" : "hover:bg-asst-hover"}`}
                  >
                    <span className="break-words">{pageName(p)}</span>
                    {p.pageTitle === null ? null : <span className="break-all text-xs text-asst-faint">{p.pagePath}</span>}
                    <span className="text-xs text-asst-faint">
                      {links.length > 1 ? `${linkLabel(p.linkId)} · ` : ""}
                      {plural(p.threads, "comment")}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div role="group" aria-label="Show comments" className="flex w-fit rounded-lg border border-asst-line p-0.5 text-[13px]">
          {(
            [
              ["page", "Page by page"],
              ["list", "All comments"]
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
              className={`rounded-md px-3 py-1 ${mode === value ? "bg-asst-active font-semibold text-asst-text" : "text-asst-muted hover:bg-asst-hover"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {page === undefined || selected === undefined ? (
          <p className="flex-1 rounded-xl border border-dashed border-asst-line px-5 py-6 text-[13px] text-asst-muted">
            {threads.length === 0 ? "No comments yet. They appear here as reviewers make them." : "No comments match these filters."}
          </p>
        ) : mode === "list" ? (
          <AllComments
            pages={pages}
            threads={narrowed}
            people={people}
            linkLabel={links.length > 1 ? linkLabel : null}
            onView={viewOnPage}
            handlers={handlers}
          />
        ) : (
          <section aria-label={`Comments on ${pageName(page)}`} className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3 text-[13px]">
              <h3 className="min-w-0 flex-1 break-words font-semibold">
                {pageName(page)}{" "}
                <span className="font-normal text-asst-faint">
                  {page.pageTitle === null ? "" : `${page.pagePath} · `}
                  {linkLabel(page.linkId)}
                </span>
              </h3>
              {link === undefined || link.revokedAt !== null ? null : (
                <a href={reviewPath(link.token, page.pagePath)} target="_blank" rel="noopener" aria-label="Open live (opens in a new tab)" className={LINK}>
                  Open live
                </a>
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-3 xl:flex-row xl:gap-0">
              <div className="min-w-0 flex-1">
                <SnapshotView projectId={projectId} thread={selected} onHighlight={setHighlight} />
              </div>
              <svg aria-hidden="true" width={GUTTER} className="hidden shrink-0 overflow-visible xl:block" style={{ minWidth: GUTTER }}>
                {highlight === null || cardTop === null || selected.status === "detached" ? null : (
                  <path
                    data-testid="margin-connector"
                    d={`M 0 ${highlight.top + highlight.height / 2} C ${GUTTER / 2} ${highlight.top + highlight.height / 2}, ${GUTTER / 2} ${cardTop}, ${GUTTER} ${cardTop}`}
                    className="fill-none stroke-asst-accent"
                    strokeWidth={1.5}
                  />
                )}
              </svg>
              <div className="relative flex shrink-0 flex-col gap-3 xl:w-[300px]">
                <ol aria-label="Comments on this page" className="flex flex-col gap-2">
                  {margin.map((thread, index) => card(thread, index))}
                </ol>
                {detached.length === 0 ? null : (
                  <div className="flex flex-col gap-2">
                    <h4 className="text-xs text-asst-faint">No longer on the page</h4>
                    <ol aria-label="Comments no longer on the page" className="flex flex-col gap-2">
                      {detached.map((thread, index) => card(thread, index))}
                    </ol>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

type GroupBy = "page" | "theme";

interface CommentGroup {
  key: string;
  heading: string;
  meta: string;
  threads: FeedbackThreadView[];
}

const NO_THEME = "No theme";

/** The threads under their pages, in the order the margin lays them out, or under their themes, those with none last. */
function groupsOf(
  groupBy: GroupBy,
  pages: readonly PageGroup[],
  threads: readonly FeedbackThreadView[],
  linkLabel: ((linkId: string) => string) | null
): CommentGroup[] {
  if (groupBy === "page") {
    return pages.map((page) => {
      const { onPage, detached } = marginOrder(threads.filter((thread) => keyOf(thread) === keyOf(page)));
      return {
        key: keyOf(page),
        heading: pageName(page),
        meta: `${page.pageTitle === null ? "" : `${page.pagePath} · `}${linkLabel === null ? "" : `${linkLabel(page.linkId)} · `}${plural(page.threads, "comment")}`,
        threads: [...onPage, ...detached]
      };
    });
  }
  const themes = [...new Set(threads.map((thread) => thread.theme))].sort((a, b) => (a === null ? 1 : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0));
  return themes.map((theme) => {
    const mine = threads
      .filter((thread) => thread.theme === theme)
      .sort((a, b) => (a.pagePath < b.pagePath ? -1 : a.pagePath > b.pagePath ? 1 : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return { key: `theme ${theme ?? ""}`, heading: theme ?? NO_THEME, meta: plural(mine.length, "comment"), threads: mine };
  });
}

/**
 * Every comment the filters leave, under the page it is on or the theme the team gave it, each as a short summary:
 * who, when, its status, what it is on and what it says, the Jira issues it went into, and the way to the page it was
 * left on. With `handlers.theme`, comments can be chosen, and the chosen ones given a theme, resolved, or, with
 * `handlers.refine`, refined with the Assistant into one Jira story, or comment by comment into as many as they need.
 */
function AllComments({
  pages,
  threads,
  people,
  linkLabel,
  onView,
  handlers
}: Readonly<{
  pages: readonly PageGroup[];
  threads: readonly FeedbackThreadView[];
  people: readonly MentionPerson[];
  /** Names a page's link, when the project has more than one for the page's to be told apart by. */
  linkLabel: ((linkId: string) => string) | null;
  onView: (thread: FeedbackThreadView) => void;
  handlers: ThreadHandlers;
}>) {
  const ids = useId();
  // Comments the team has already given themes are read a theme at a time.
  const [groupBy, setGroupBy] = useState<GroupBy>(() => (threads.some((thread) => thread.theme !== null) ? "theme" : "page"));
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  // What was typed into the theme box, for the choice it was typed for; a new choice shows its own theme again.
  const [typed, setTyped] = useState<{ choice: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choosable = handlers.theme !== undefined;
  // Only what is still shown counts as chosen: a filter or a refresh can take a chosen thread out of the list.
  const selected = threads.filter((thread) => chosen.has(thread.id));
  const every = selected.length === threads.length && threads.length > 0;
  const themes = [...new Set(threads.flatMap((thread) => (thread.theme === null ? [] : [thread.theme])))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const choice = selected.map((thread) => thread.id).join(" ");
  const chosenThemes = new Set(selected.map((thread) => thread.theme));
  // The theme every chosen comment already has, which the box shows; null when they have none, or different ones.
  const shared = chosenThemes.size === 1 ? (selected[0]?.theme ?? null) : null;
  const mixed = chosenThemes.size > 1;
  const theme = typed !== null && typed.choice === choice ? typed.text : (shared ?? "");
  const setTheme = (text: string) => setTyped({ choice, text });

  function choose(id: string, on: boolean): void {
    setChosen((current) => {
      const next = new Set(current);
      if (on) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  async function run(work: () => Promise<string | null>, after?: () => void): Promise<void> {
    setBusy(true);
    setError(null);
    const failure = await work();
    setBusy(false);
    if (failure === null) {
      after?.();
    } else {
      setError(failure);
    }
  }

  const chosenIds = () => selected.map((thread) => thread.id);
  // The chosen are resolved while any of them is open; once none is, the same button reopens the resolved ones, so a
  // Resolve pressed by mistake is undone where it was pressed.
  const reopening = !selected.some((thread) => thread.status === "open") && selected.some((thread) => thread.status === "resolved");
  const setChosenStatus = async (): Promise<string | null> => {
    const [from, to] = reopening ? (["resolved", "open"] as const) : (["open", "resolved"] as const);
    for (const thread of selected.filter((t) => t.status === from)) {
      const failure = await handlers.status(thread.id, to);
      if (failure !== null) {
        return failure;
      }
    }
    return null;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        {choosable ? (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={every}
              ref={(box) => {
                if (box !== null) {
                  box.indeterminate = selected.length > 0 && !every;
                }
              }}
              onChange={(event) => setChosen(event.target.checked ? new Set(threads.map((thread) => thread.id)) : new Set())}
            />
            Select all {threads.length} shown
          </label>
        ) : null}
        <label className="flex items-center gap-2">
          Group by
          <select value={groupBy} onChange={(event) => setGroupBy(event.target.value as GroupBy)} className={FIELD}>
            <option value="page">Page</option>
            <option value="theme">Theme</option>
          </select>
        </label>
      </div>

      {selected.length === 0 && error !== null ? (
        <p role="alert" className="text-[13px] text-asst-error">
          {error}
        </p>
      ) : null}

      {choosable && selected.length > 0 ? (
        <section
          aria-label="Chosen comments"
          // A solid ground under the tint, since the bar stays on top of the list as it scrolls.
          className="sticky top-0 z-10 rounded-xl bg-asst-raised text-[13px] shadow-md"
        >
          <div className="flex flex-col gap-2 rounded-xl border-2 border-asst-accent bg-asst-accent/10 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{plural(selected.length, "comment")} chosen</span>
              <button type="button" className="rounded-md px-1.5 text-asst-accent underline hover:bg-asst-field" onClick={() => setChosen(new Set())}>
                Clear
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">Organise</span>
              <label htmlFor={`${ids}-theme`} className="text-asst-muted">
                Theme<span className="sr-only"> for the chosen comments</span>
              </label>
              <input
                id={`${ids}-theme`}
                list={`${ids}-themes`}
                value={theme}
                maxLength={MAX_THEME}
                placeholder={mixed ? "Mixed themes: type one to give them all" : "Theme, such as Court fees"}
                onChange={(event) => setTheme(event.target.value)}
                className={`${FIELD} w-72`}
              />
              <datalist id={`${ids}-themes`}>
                {themes.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <button
                type="button"
                className={SECONDARY}
                disabled={busy || theme.trim() === "" || theme.trim() === shared}
                onClick={() =>
                  void run(
                    () => (handlers.theme as NonNullable<ThreadHandlers["theme"]>)(chosenIds(), theme),
                    () => setTyped(null)
                  )
                }
              >
                Set theme
              </button>
              <button
                type="button"
                className={SECONDARY}
                disabled={busy || selected.every((thread) => thread.theme === null)}
                onClick={() => void run(() => (handlers.theme as NonNullable<ThreadHandlers["theme"]>)(chosenIds(), null))}
              >
                Remove theme
              </button>
              <button
                type="button"
                className={SECONDARY}
                disabled={busy || selected.every((thread) => thread.status === "detached")}
                onClick={() => void run(setChosenStatus)}
              >
                {reopening ? "Reopen" : "Resolve"}
              </button>
            </div>
            {handlers.refine === undefined ? null : (
              <div className="flex flex-col gap-1.5 border-t border-asst-line pt-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">Turn into Jira stories</span>
                  {(
                    [
                      ["one", "Refine into one story", PRIMARY],
                      ["each", "Refine comment by comment", SECONDARY]
                    ] as const
                  ).map(([mode, label, look]) => (
                    <button
                      key={mode}
                      type="button"
                      className={look}
                      disabled={busy || selected.length > MAX_REFINE_THREADS}
                      aria-describedby={selected.length > MAX_REFINE_THREADS ? `${ids}-refine-hint` : undefined}
                      onClick={() => void run(() => (handlers.refine as NonNullable<ThreadHandlers["refine"]>)(chosenIds(), mode))}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {selected.length > MAX_REFINE_THREADS ? (
                  <p id={`${ids}-refine-hint`} className="text-xs text-asst-muted">
                    Choose at most {MAX_REFINE_THREADS} comments to refine at once.
                  </p>
                ) : null}
              </div>
            )}
            <p role="alert" className={`text-asst-error ${error === null ? "sr-only" : ""}`}>
              {error ?? ""}
            </p>
          </div>
        </section>
      ) : null}

      {groupsOf(groupBy, pages, threads, linkLabel).map((group, index) => {
        const headingId = `${ids}-group-${index}`;
        return (
          <section key={group.key} aria-labelledby={headingId} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {choosable ? (
                <input
                  type="checkbox"
                  aria-label={`Choose all ${plural(group.threads.length, "comment")} in ${group.heading}`}
                  checked={group.threads.every((thread) => chosen.has(thread.id))}
                  ref={(box) => {
                    if (box !== null) {
                      const some = group.threads.some((thread) => chosen.has(thread.id));
                      box.indeterminate = some && !group.threads.every((thread) => chosen.has(thread.id));
                    }
                  }}
                  onChange={(event) =>
                    setChosen((current) => {
                      const next = new Set(current);
                      for (const thread of group.threads) {
                        if (event.target.checked) {
                          next.add(thread.id);
                        } else {
                          next.delete(thread.id);
                        }
                      }
                      return next;
                    })
                  }
                />
              ) : null}
              <h3 id={headingId} className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 text-sm font-semibold">
                <span className="break-words">{group.heading}</span>
                <span className="text-xs font-normal text-asst-faint">{group.meta}</span>
              </h3>
            </div>
            <ol className="flex flex-col gap-2">
              {group.threads.map((thread) => (
                <ThreadSummary
                  key={thread.id}
                  thread={thread}
                  people={people}
                  onView={() => onView(thread)}
                  showPage={groupBy === "theme"}
                  choice={choosable ? { chosen: chosen.has(thread.id), onChange: (on) => choose(thread.id, on) } : null}
                />
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

function ThreadSummary({
  thread,
  people,
  onView,
  showPage,
  choice
}: Readonly<{
  thread: FeedbackThreadView;
  people: readonly MentionPerson[];
  onView: () => void;
  /** Says which page it is on, as a list grouped by theme has to, where its theme is the heading it is under. */
  showPage: boolean;
  /** Whether it is chosen, and the way to choose it; null where nothing can be. */
  choice: { chosen: boolean; onChange: (on: boolean) => void } | null;
}>) {
  const [first, ...replies] = thread.comments;
  const latest = replies.at(-1);
  return (
    <li>
      <article
        aria-label={`Comment by ${thread.author.name}`}
        className={`flex gap-3 rounded-xl border bg-asst-raised px-3 py-2.5 ${choice?.chosen ? "border-asst-accent-line" : "border-asst-line"} ${thread.status === "open" ? "" : "opacity-80"}`}
      >
        {choice === null ? null : (
          <input
            type="checkbox"
            className="mt-1 shrink-0"
            checked={choice.chosen}
            aria-label={`Choose the comment by ${thread.author.name}${first === undefined ? "" : `: ${first.body.slice(0, 60)}`}`}
            onChange={(event) => choice.onChange(event.target.checked)}
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-asst-faint">
            <span className="text-sm font-semibold text-asst-text">{thread.author.name}</span>
            {first === undefined ? null : <Timestamp iso={first.createdAt} />}
            <span
              className={`rounded-full px-1.5 py-px ${thread.status === "open" ? "bg-asst-accent-soft/20 text-asst-accent" : "bg-asst-field text-asst-muted"}`}
            >
              {STATUS_WORDS[thread.status]}
            </span>
            {thread.theme === null || showPage ? null : (
              <span className="rounded-full border border-asst-strong px-1.5 py-px text-asst-muted">Theme: {thread.theme}</span>
            )}
            {thread.jiraKeys.map((key) => (
              <span key={key} className="rounded-full bg-asst-field px-1.5 py-px font-semibold text-asst-text">
                Jira {key}
              </span>
            ))}
          </p>
          <p className="text-xs text-asst-muted">
            On {showPage ? `${pageName(thread)}, ` : ""}
            {describeElement(thread.anchor)}
          </p>
          {first === undefined ? null : <CommentBody body={first.body} mentions={first.mentions} people={people} />}
          {latest === undefined ? null : (
            <p className="border-l-2 border-asst-line pl-2 text-xs text-asst-muted">
              {plural(replies.length, "reply", "replies")} · latest from <span className="font-semibold">{latest.author.name}</span>:{" "}
              {latest.body.length > 120 ? `${latest.body.slice(0, 120)}…` : latest.body}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onView}
              aria-label="View on page and reply"
              className="rounded-md px-1.5 py-0.5 text-[13px] text-asst-accent underline hover:bg-asst-field"
            >
              View on page
            </button>
            {thread.refinedIn === null ? null : (
              <Link href={`/assistant/${thread.refinedIn}`} className={`${LINK} text-[13px]`}>
                Refined in your chat
              </Link>
            )}
          </div>
        </div>
      </article>
    </li>
  );
}
