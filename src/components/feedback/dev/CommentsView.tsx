"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MentionPerson } from "@/components/feedback/MentionInput";
import { CommentBody, STATUS_WORDS, ThreadCard } from "@/components/feedback/ThreadCard";
import { Timestamp } from "@/components/time/Timestamp";
import { describeElement } from "@/feedback/anchor-words";
import type { FeedbackLinkView } from "@/feedback/store";
import { filterThreads, marginOrder, NO_FILTER, type PageGroup, pageName, pagesOf, type ThreadFilter } from "@/feedback/team-views";
import type { FeedbackThreadStatus, FeedbackThreadView } from "@/feedback/thread-store";
import { FIELD, LINK, plural, reviewPath } from "./look";
import { type Highlight, SnapshotView } from "./SnapshotView";

/**
 * The project's comments, two ways. `list`, the first a person sees, is every comment that matches the filters in one
 * list, grouped by the page it is on, so the whole round can be read top to bottom. `page` is a document's margin:
 * pick a page, and its snapshot is shown with the selected thread's element outlined and a line to that thread's
 * card, the page's cards down the right in the order their elements are down the page. Choosing a comment's
 * "View on page" in the list opens it there. Threads whose element has gone are listed apart, under the page's others.
 */

export type CommentsMode = "list" | "page";

export interface ThreadHandlers {
  reply: (threadId: string, body: string) => Promise<string | null>;
  status: (threadId: string, status: "open" | "resolved") => Promise<string | null>;
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
  initialMode = "list",
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
              ["list", "All comments"],
              ["page", "Page by page"]
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
          <AllComments pages={pages} threads={narrowed} people={people} linkLabel={links.length > 1 ? linkLabel : null} onView={viewOnPage} />
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

/**
 * Every comment the filters leave, under the page it is on, each as a short summary: who, when, its status, what it
 * is on and what it says, with the way to the page it was left on.
 */
function AllComments({
  pages,
  threads,
  people,
  linkLabel,
  onView
}: Readonly<{
  pages: readonly PageGroup[];
  threads: readonly FeedbackThreadView[];
  people: readonly MentionPerson[];
  /** Names a page's link, when the project has more than one for the page's to be told apart by. */
  linkLabel: ((linkId: string) => string) | null;
  onView: (thread: FeedbackThreadView) => void;
}>) {
  return (
    <div className="flex flex-col gap-5">
      {pages.map((page) => {
        const { onPage, detached } = marginOrder(threads.filter((thread) => keyOf(thread) === keyOf(page)));
        const headingId = `page-${keyOf(page).replace(/[^a-zA-Z0-9-]/g, "-")}`;
        return (
          <section key={keyOf(page)} aria-labelledby={headingId} className="flex flex-col gap-2">
            <h3 id={headingId} className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold">
              <span className="break-words">{pageName(page)}</span>
              <span className="text-xs font-normal text-asst-faint">
                {page.pageTitle === null ? "" : `${page.pagePath} · `}
                {linkLabel === null ? "" : `${linkLabel(page.linkId)} · `}
                {plural(page.threads, "comment")}
              </span>
            </h3>
            <ol className="flex flex-col gap-2">
              {[...onPage, ...detached].map((thread) => (
                <ThreadSummary key={thread.id} thread={thread} people={people} onView={() => onView(thread)} />
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

function ThreadSummary({ thread, people, onView }: Readonly<{ thread: FeedbackThreadView; people: readonly MentionPerson[]; onView: () => void }>) {
  const [first, ...replies] = thread.comments;
  const latest = replies.at(-1);
  return (
    <li>
      <article
        aria-label={`Comment by ${thread.author.name}`}
        className={`flex flex-col gap-1.5 rounded-xl border border-asst-line bg-asst-raised px-3 py-2.5 ${thread.status === "open" ? "" : "opacity-80"}`}
      >
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-asst-faint">
          <span className="text-sm font-semibold text-asst-text">{thread.author.name}</span>
          {first === undefined ? null : <Timestamp iso={first.createdAt} />}
          <span
            className={`rounded-full px-1.5 py-px ${thread.status === "open" ? "bg-asst-accent-soft/20 text-asst-accent" : "bg-asst-field text-asst-muted"}`}
          >
            {STATUS_WORDS[thread.status]}
          </span>
        </p>
        <p className="text-xs text-asst-muted">On {describeElement(thread.anchor)}</p>
        {first === undefined ? null : <CommentBody body={first.body} mentions={first.mentions} people={people} />}
        {latest === undefined ? null : (
          <p className="border-l-2 border-asst-line pl-2 text-xs text-asst-muted">
            {plural(replies.length, "reply", "replies")} · latest from <span className="font-semibold">{latest.author.name}</span>:{" "}
            {latest.body.length > 120 ? `${latest.body.slice(0, 120)}…` : latest.body}
          </p>
        )}
        <div>
          <button
            type="button"
            onClick={onView}
            aria-label="View on page and reply"
            className="rounded-md px-1.5 py-0.5 text-[13px] text-asst-accent underline hover:bg-asst-field"
          >
            View on page
          </button>
        </div>
      </article>
    </li>
  );
}
